package api

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"
	smithy "github.com/aws/smithy-go"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

// DefaultS3ConfigName is the Secret the operator provisions at startup for the
// in-cluster SeaweedFS. Environments that set no spec.s3ConfigRef fall back to it.
const DefaultS3ConfigName = "seaweedfs-default"

// seaweedfsNodePort is the NodePort the in-cluster SeaweedFS S3 API is exposed
// on. The k6 runner lives on remote VMs that cannot resolve the internal cluster
// DNS, so asset URLs for the default SeaweedFS are rewritten to
// <nodeIP>:<seaweedfsNodePort>.
const seaweedfsNodePort = "30900"

// assetTagging is applied to every uploaded object so operators can identify
// (and later sweep) k6 payload assets.
const assetTagging = "dfaas.io/asset=true"

// maxAssetUploadBytes is the hard ceiling on the whole multipart request body.
// ParseMultipartForm's argument only bounds the IN-MEMORY portion — anything
// past it spills to disk with no aggregate limit — and this endpoint carries no
// authentication, so the ceiling goes on the body itself. Keeping the in-memory
// budget equal to the ceiling also means nothing ever reaches the disk.
const maxAssetUploadBytes = 32 << 20

// NodeGVR is the GVR for core/v1 Nodes, listed to derive the in-cluster SeaweedFS
// public address (node IP + NodePort) for the default S3 config.
var NodeGVR = schema.GroupVersionResource{
	Group:    "",
	Version:  "v1",
	Resource: "nodes",
}

// assetFilenameSub collapses every character that is unsafe inside an S3 object
// key segment into a single dash.
var assetFilenameSub = regexp.MustCompile(`[^a-zA-Z0-9._-]+`)

// bucketRegexp matches every character that is NOT valid inside an S3 bucket
// DNS label (lowercase alnum and dash).
var bucketRegexp = regexp.MustCompile(`[^a-z0-9-]+`)

// dashRunRegexp collapses repeated dashes produced by sanitization.
var dashRunRegexp = regexp.MustCompile(`-+`)

// UploadLoadTestAsset receives a multipart file and stores it in the
// environment's S3 bucket under assets/<uuid>-<filename>, returning a public URL
// that the client-side k6 generator embeds as a request body. The object is
// made anonymously readable via a one-time bucket policy so remote k6 runners
// can fetch it without credentials.
//
// The answer is an UploadAssetResponse. On the in-cluster SeaweedFS it is also
// relocatable: path is "/<bucket>/<key>", which a runner given DFAAS_ASSET_BASE
// (its own management address on the S3 NodePort, set by the operator) fetches
// instead of url. url stays the absolute URL baked at upload time, the fallback
// for a runner with no DFAAS_ASSET_BASE, so it must be one a k6 VM can use
// whether or not the asset is relocatable — hence the 502 and the 409 below.
func (h *Handler) UploadLoadTestAsset(c *gin.Context) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxAssetUploadBytes)
	if err := c.Request.ParseMultipartForm(maxAssetUploadBytes); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": fmt.Sprintf("upload exceeds the %d MiB limit", maxAssetUploadBytes>>20)})
			return
		}
		c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("parse multipart form: %v", err)})
		return
	}

	namespace := c.Request.FormValue("namespace")
	environment := c.Request.FormValue("environment")
	if namespace == "" || environment == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "namespace and environment form fields are required"})
		return
	}

	fileHeader, err := c.FormFile("file")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("missing 'file' part: %v", err)})
		return
	}

	src, err := fileHeader.Open()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("open uploaded file: %v", err)})
		return
	}
	defer src.Close()

	payload, err := io.ReadAll(src)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("read uploaded file: %v", err)})
		return
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), 60*time.Second)
	defer cancel()

	// Resolve the target Environment: its s3ConfigRef picks the Secret, its UID
	// names the bucket.
	envObj, err := h.client.Resource(EnvironmentGVR).Namespace(namespace).Get(ctx, environment, metav1.GetOptions{})
	if err != nil {
		writeK8sError(c, err, fmt.Sprintf("environment '%s/%s'", namespace, environment))
		return
	}
	envUID := string(envObj.GetUID())

	configName := getNestedString(envObj.Object, "spec", "s3ConfigRef", "name")
	if configName == "" {
		configName = DefaultS3ConfigName
	}

	// The in-cluster SeaweedFS is reached over <nodeIP>:<NodePort> both by this
	// gateway (dev mode) and by the remote k6 runners. Resolve that IP once, up
	// front, and fail here rather than after the upload: falling back to the
	// internal cluster DNS would hand back a 201 carrying a URL no k6 VM can
	// resolve, and the failure would only surface at test runtime as an opaque
	// DNS error. Skipped entirely when explicit overrides cover both uses.
	var nodeIP string
	if h.addressing.NeedsNodeIP(configName) {
		ip, nerr := h.firstNodeIP(ctx)
		if nerr != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("resolve a cluster node address for the in-cluster SeaweedFS: %v — grant the gateway 'list nodes', or set SEAWEEDFS_PUBLIC_URL to the address remote k6 runners can reach", nerr)})
			return
		}
		if ip == "" {
			c.JSON(http.StatusBadGateway, gin.H{"error": "no cluster node exposes a usable address for the in-cluster SeaweedFS; set SEAWEEDFS_PUBLIC_URL (and SEAWEEDFS_ENDPOINT when the gateway runs outside the cluster)"})
			return
		}
		nodeIP = ip
	}

	// Read the resolved S3 config Secret from the registry namespace.
	secret, err := h.client.Resource(SecretGVR).Namespace(S3ConfigNamespace).Get(ctx, configName, metav1.GetOptions{})
	if err != nil {
		if apierrors.IsNotFound(err) {
			c.JSON(http.StatusConflict, gin.H{"error": fmt.Sprintf("S3 config secret '%s/%s' not found; the operator provisions '%s' at startup", S3ConfigNamespace, configName, DefaultS3ConfigName)})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("read s3 config '%s': %v", configName, err)})
		return
	}

	// A field that fails to decode must not degrade to "": a blank credential
	// reaches S3 as an opaque "access denied" with nothing naming the culprit.
	var decodeErr error
	field := func(key string) string {
		v, ferr := decodeSecretValue(secret.Object, key)
		if ferr != nil && decodeErr == nil {
			decodeErr = ferr
		}
		return v
	}
	endpoint := field("endpoint")
	region := field("region")
	accessKey := field("access_key_id")
	secretKey := field("secret_access_key")
	forcePathStyleRaw := field("force_path_style")
	if decodeErr != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("s3 config '%s/%s': %v", S3ConfigNamespace, configName, decodeErr)})
		return
	}
	forcePathStyle := false
	if forcePathStyleRaw != "" {
		forcePathStyle, err = strconv.ParseBool(forcePathStyleRaw)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("s3 config '%s/%s': field \"force_path_style\" is not a boolean: %v", S3ConfigNamespace, configName, err)})
			return
		}
	}

	// An external config's url is its own endpoint plus the object path. With
	// no endpoint (the AWS default, which only the S3 client resolves) or one
	// with no http(s) scheme, that url is relative and no k6 VM can fetch it.
	// Refuse before anything is written, as the 502 above does for the default
	// config, rather than answer 201 with a URL that fails on every runner.
	if !isDefaultS3Config(configName) && !isAbsoluteHTTPURL(endpoint) {
		c.JSON(http.StatusConflict, gin.H{"error": fmt.Sprintf("S3 config '%s/%s' has no absolute http(s) endpoint (got %q): k6 runners fetch payload assets anonymously at <endpoint>/<bucket>/<key>, so the config needs an endpoint URL they can reach", S3ConfigNamespace, configName, endpoint)})
		return
	}

	// The gateway must DIAL a reachable endpoint. For the in-cluster SeaweedFS the
	// Secret holds the internal cluster DNS, unreachable when the gateway runs
	// outside the cluster (dev mode) — resolve a node-IP:NodePort fallback.
	connectEndpoint := h.addressing.ConnectEndpoint(configName, endpoint, nodeIP)

	s3Client, err := h.store()(ctx, region, connectEndpoint, accessKey, secretKey, forcePathStyle)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("build s3 client: %v", err)})
		return
	}

	bucket := bucketNameFor(environment, envUID)
	if err := ensureBucket(ctx, s3Client, bucket, region); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if err := ensureAssetsPublicPolicy(ctx, s3Client, bucket); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	key := fmt.Sprintf("assets/%s-%s", uuid.NewString(), sanitizeAssetFilename(fileHeader.Filename))
	contentType := detectContentType(payload, fileHeader.Header.Get("Content-Type"))

	if _, err := s3Client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:      aws.String(bucket),
		Key:         aws.String(key),
		Body:        bytes.NewReader(payload),
		ContentType: aws.String(contentType),
		Tagging:     aws.String(assetTagging),
	}); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("put object: %v", err)})
		return
	}

	resp := UploadAssetResponse{
		URL:         h.addressing.PublicURL(configName, endpoint, bucket, key, nodeIP),
		ContentType: contentType,
		Filename:    fileHeader.Filename,
	}
	if h.addressing.Relocatable(configName) {
		resp.Relocatable = true
		resp.Path = assetPath(bucket, key)
	}
	c.JSON(http.StatusCreated, resp)
}

// objectStore is exactly the four calls the asset-upload path makes, so the
// handler runs against a fake.
type objectStore interface {
	HeadBucket(ctx context.Context, in *s3.HeadBucketInput, opts ...func(*s3.Options)) (*s3.HeadBucketOutput, error)
	CreateBucket(ctx context.Context, in *s3.CreateBucketInput, opts ...func(*s3.Options)) (*s3.CreateBucketOutput, error)
	PutBucketPolicy(ctx context.Context, in *s3.PutBucketPolicyInput, opts ...func(*s3.Options)) (*s3.PutBucketPolicyOutput, error)
	PutObject(ctx context.Context, in *s3.PutObjectInput, opts ...func(*s3.Options)) (*s3.PutObjectOutput, error)
}

var _ objectStore = (*s3.Client)(nil)

// storeFactory builds a store for one resolved S3 config.
type storeFactory func(ctx context.Context, region, endpoint, accessKey, secretKey string, forcePathStyle bool) (objectStore, error)

// liveStore is the production factory.
func liveStore(ctx context.Context, region, endpoint, accessKey, secretKey string, forcePathStyle bool) (objectStore, error) {
	return newS3Client(ctx, region, endpoint, accessKey, secretKey, forcePathStyle)
}

// store is the nil-safe accessor for Handler.newStore.
func (h *Handler) store() storeFactory {
	if h.newStore != nil {
		return h.newStore
	}
	return liveStore
}

// assetAddressing holds the environment-derived inputs of the three URL
// resolutions: what the gateway dials (ConnectEndpoint), what the k6 VMs dial
// (PublicURL) and what the browser opens (FilerBase, results.go).
//
// ConnectOverride and PublicOverride are SeaweedFS overrides: they apply to the
// default config only, and an external S3 config keeps its own endpoint.
type assetAddressing struct {
	// ConnectOverride is SEAWEEDFS_ENDPOINT: what the gateway dials.
	ConnectOverride string
	// PublicOverride is SEAWEEDFS_PUBLIC_URL: the base of the URL baked for
	// the k6 VMs, which a runner given DFAAS_ASSET_BASE does not dial.
	PublicOverride string
	// FilerOverride is SEAWEEDFS_FILER_PUBLIC_URL: base of the result links
	// the browser opens.
	FilerOverride string
	// InCluster is whether this process runs inside a Pod. The kubelet injects
	// KUBERNETES_SERVICE_HOST into every Pod and it is absent in local/dev
	// runs — the same signal rest.InClusterConfig() keys off (see NewK8sClient
	// in k8s_client.go).
	InCluster bool
}

// addressingFromEnv reads the environment once, at handler construction.
func addressingFromEnv() assetAddressing {
	return assetAddressing{
		ConnectOverride: strings.TrimRight(os.Getenv("SEAWEEDFS_ENDPOINT"), "/"),
		PublicOverride:  strings.TrimRight(os.Getenv("SEAWEEDFS_PUBLIC_URL"), "/"),
		FilerOverride:   strings.TrimRight(os.Getenv("SEAWEEDFS_FILER_PUBLIC_URL"), "/"),
		InCluster:       os.Getenv("KUBERNETES_SERVICE_HOST") != "",
	}
}

// isDefaultS3Config reports whether configName names the built-in in-cluster SeaweedFS.
func isDefaultS3Config(configName string) bool { return configName == DefaultS3ConfigName }

// assetPath is the object's path on an S3 endpoint in path-style addressing:
// "/<bucket>/<key>". Every PublicURL ends with it, and a relocatable upload
// returns it on its own. No escaping: bucketNameFor emits [a-z0-9-] and the key
// is assets/<uuid>-<sanitizeAssetFilename>, all [A-Za-z0-9._/-]. Widening the
// sanitizer would need url.PathEscape on each segment.
func assetPath(bucket, key string) string { return "/" + bucket + "/" + key }

// Relocatable reports whether a runner may fetch the asset from another base
// than the one baked into url: true exactly for the in-cluster SeaweedFS, which
// every generator reaches on the S3 NodePort of the management node, at the
// address the operator detected for it (DFAAS_ASSET_BASE). The decision is by
// config name only, because the gateway knows no SeaweedFS DNS: a config with
// another name stays on its own endpoint even if it points at the same store.
// SEAWEEDFS_PUBLIC_URL does not turn relocation off: it only sets the fallback.
func (a assetAddressing) Relocatable(configName string) bool {
	return isDefaultS3Config(configName)
}

// NeedsNodeIP reports whether this upload has to resolve a cluster node address
// before it can hand back a URL a remote k6 runner can reach. Both overrides
// together make it unnecessary; in-cluster, only the public one is needed.
func (a assetAddressing) NeedsNodeIP(configName string) bool {
	if !isDefaultS3Config(configName) {
		return false
	}
	return a.PublicOverride == "" || (a.ConnectOverride == "" && !a.InCluster)
}

// ConnectEndpoint returns the endpoint the GATEWAY dials to reach the object
// store — auto-detected, so the common cases need no configuration:
//
//   - explicit external S3 config   → its own endpoint, whatever is set below.
//   - default in-cluster SeaweedFS:
//   - SEAWEEDFS_ENDPOINT set      → explicit override, always wins.
//   - gateway in-cluster          → the Secret's internal DNS endpoint
//     (seaweedfs-all-in-one.monitoring.svc…:8333) — the canonical ClusterIP path.
//   - gateway outside the cluster → http://<nodeIP>:<seaweedfsNodePort>; the
//     internal DNS would fail to resolve ("no such host"), so dial the
//     node IP + NodePort instead (reachable from outside).
//
// SEAWEEDFS_ENDPOINT names the in-cluster SeaweedFS: applied to an external
// config it would send that config's credentials and objects to SeaweedFS.
//
// nodeIP is resolved once per request by the caller (see UploadLoadTestAsset),
// which also decides whether an unresolvable node address is fatal.
//
// This is distinct from PublicURL (the k6-facing asset URL); the two
// endpoints are resolved independently.
func (a assetAddressing) ConnectEndpoint(configName, endpoint, nodeIP string) string {
	if !isDefaultS3Config(configName) {
		return endpoint
	}
	if a.ConnectOverride != "" {
		return a.ConnectOverride
	}
	if !a.InCluster && nodeIP != "" {
		return "http://" + net.JoinHostPort(nodeIP, seaweedfsNodePort)
	}
	return endpoint
}

// PublicURL builds the externally reachable URL of an uploaded asset; every
// branch ends with assetPath(bucket, key).
//
//   - explicit external S3         → <endpoint>/<bucket>/<key>
//   - default in-cluster SeaweedFS:
//   - SEAWEEDFS_PUBLIC_URL set     → <SEAWEEDFS_PUBLIC_URL>/<bucket>/<key>
//   - else                         → http://<nodeIP>:30900/<bucket>/<key>
//     (the internal DNS endpoint is unreachable from remote k6 VMs, so the URL
//     is rewritten to a node IP + the SeaweedFS S3 API NodePort)
//
// SEAWEEDFS_PUBLIC_URL is the address of the in-cluster SeaweedFS, so an
// external config ignores it: that object does not live there.
//
// There is no internal-DNS fallback for the default config: the caller refuses
// the upload outright when no node IP is available, rather than handing back a
// URL that only fails later, on a remote k6 VM.
func (a assetAddressing) PublicURL(configName, endpoint, bucket, key, nodeIP string) string {
	path := assetPath(bucket, key)
	if !isDefaultS3Config(configName) {
		return strings.TrimRight(endpoint, "/") + path
	}
	if a.PublicOverride != "" {
		return a.PublicOverride + path
	}
	if nodeIP != "" {
		return "http://" + net.JoinHostPort(nodeIP, seaweedfsNodePort) + path
	}
	return strings.TrimRight(endpoint, "/") + path
}

// isAbsoluteHTTPURL reports whether s is an http or https URL with a host: what
// an external config's endpoint must be for the URL PublicURL builds on it to be
// fetchable from a k6 VM.
func isAbsoluteHTTPURL(s string) bool {
	u, err := url.Parse(s)
	return err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Host != ""
}

// firstNodeIP lists cluster Nodes and returns the first ExternalIP, falling back
// to the first InternalIP.
//
// The error distinguishes "the lookup failed" (List error/timeout) from "the
// cluster genuinely has no Node carrying a usable address" (empty string, nil
// error) — collapsing the two would turn an API blip into a silent fallback
// to an unreachable endpoint.
//
// NOTE: on a multi-node cluster SeaweedFS's NodePort is reachable on every node,
// but the chosen node may not be the one actually scheduling the SeaweedFS Pod.
// This is fine for a NodePort Service (kube-proxy forwards across nodes) but
// means the returned IP is "some" node, not necessarily the SeaweedFS host.
func (h *Handler) firstNodeIP(ctx context.Context) (string, error) {
	nodes, err := h.client.Resource(NodeGVR).List(ctx, metav1.ListOptions{})
	if err != nil {
		return "", fmt.Errorf("list nodes: %w", err)
	}
	var internalFallback string
	for _, node := range nodes.Items {
		addrs, _, _ := unstructured.NestedSlice(node.Object, "status", "addresses")
		for _, raw := range addrs {
			addr, ok := raw.(map[string]interface{})
			if !ok {
				continue
			}
			switch getStringFromMap(addr, "type") {
			case "ExternalIP":
				if ip := getStringFromMap(addr, "address"); ip != "" {
					return ip, nil
				}
			case "InternalIP":
				if internalFallback == "" {
					internalFallback = getStringFromMap(addr, "address")
				}
			}
		}
	}
	return internalFallback, nil
}

// newS3Client builds an aws-sdk-go-v2 S3 client with static credentials, an
// optional custom BaseEndpoint (SeaweedFS), and path-style addressing toggle.
func newS3Client(ctx context.Context, region, endpoint, accessKey, secretKey string, forcePathStyle bool) (*s3.Client, error) {
	cfg, err := config.LoadDefaultConfig(ctx,
		config.WithRegion(region),
		config.WithCredentialsProvider(
			credentials.NewStaticCredentialsProvider(accessKey, secretKey, ""),
		),
	)
	if err != nil {
		return nil, fmt.Errorf("load aws config: %w", err)
	}
	return s3.NewFromConfig(cfg, func(o *s3.Options) {
		if endpoint != "" {
			o.BaseEndpoint = aws.String(endpoint)
		}
		o.UsePathStyle = forcePathStyle
	}), nil
}

// ensureBucket HeadBuckets and, on a missing bucket, CreateBuckets it. Mirrors
// the exporter's idempotent create path.
func ensureBucket(ctx context.Context, client objectStore, bucket, region string) error {
	_, err := client.HeadBucket(ctx, &s3.HeadBucketInput{Bucket: aws.String(bucket)})
	if err == nil {
		return nil
	}
	// SeaweedFS returns 403 Forbidden (not 404) for HeadBucket on a bucket that
	// doesn't exist yet, so treat Forbidden like NotFound and fall through to
	// CreateBucket. A genuine auth failure then surfaces on CreateBucket below.
	if !isS3NotFound(err) && !isS3Forbidden(err) {
		return fmt.Errorf("head bucket %q: %w", bucket, err)
	}

	createIn := &s3.CreateBucketInput{Bucket: aws.String(bucket)}
	// AWS rejects LocationConstraint=us-east-1 (the v2 default region path); any
	// other region must be declared or the bucket lands at the endpoint default.
	if region != "" && region != "us-east-1" {
		createIn.CreateBucketConfiguration = &s3types.CreateBucketConfiguration{
			LocationConstraint: s3types.BucketLocationConstraint(region),
		}
	}
	if _, cerr := client.CreateBucket(ctx, createIn); cerr != nil {
		if isS3OwnedByYou(cerr) || isS3AlreadyExists(cerr) {
			// Race with a concurrent uploader / exporter, or a pre-existing
			// bucket — proceed to PutObject either way.
			return nil
		}
		return fmt.Errorf("create bucket %q: %w", bucket, cerr)
	}
	return nil
}

// assetsPublicPolicy grants anonymous s3:GetObject on the assets/ prefix only.
func assetsPublicPolicy(bucket string) string {
	return fmt.Sprintf(`{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DFaaSPublicAssetsRead",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::%s/assets/*"
    }
  ]
}`, bucket)
}

// ensureAssetsPublicPolicy sets the anonymous-read policy on assets/*. It is
// idempotent — PutBucketPolicy overwrites, so re-applying the same document is a
// no-op from the consumer's perspective.
func ensureAssetsPublicPolicy(ctx context.Context, client objectStore, bucket string) error {
	if _, err := client.PutBucketPolicy(ctx, &s3.PutBucketPolicyInput{
		Bucket: aws.String(bucket),
		Policy: aws.String(assetsPublicPolicy(bucket)),
	}); err != nil {
		return fmt.Errorf("put bucket policy on %q: %w", bucket, err)
	}
	return nil
}

// detectContentType sniffs the first 512 bytes of the payload, falling back to
// the multipart Content-Type header when sniffing yields the generic
// octet-stream type.
func detectContentType(payload []byte, headerType string) string {
	sniff := payload
	if len(sniff) > 512 {
		sniff = sniff[:512]
	}
	detected := http.DetectContentType(sniff)
	if detected == "application/octet-stream" && headerType != "" {
		return headerType
	}
	return detected
}

// sanitizeAssetFilename keeps the object-key segment safe and readable. Empty
// names degrade to "file".
func sanitizeAssetFilename(name string) string {
	// Drop any path component a browser may have included.
	if idx := strings.LastIndexAny(name, `/\`); idx >= 0 {
		name = name[idx+1:]
	}
	name = assetFilenameSub.ReplaceAllString(name, "-")
	name = strings.Trim(name, "-.")
	if name == "" {
		return "file"
	}
	return name
}

// bucketNameFor builds a deterministic, S3-compliant bucket name from the
// Environment name and UID. Ported verbatim from the exporter
// (DFaaSOperator/dataExporter/main.go) so uploads land in the same bucket the exporter reads.
//
//   - lowercase the env name,
//   - replace non-[a-z0-9-] with "-",
//   - collapse repeated "-",
//   - trim leading/trailing "-",
//   - clamp the base to 56 chars,
//   - append "-" + first 6 chars of envUID (lowercase hex).
//
// Final length is at most 63 chars (56 + 1 + 6), satisfying S3's 3-63 char rule.
func bucketNameFor(envName, envUID string) string {
	name := strings.ToLower(envName)
	name = bucketRegexp.ReplaceAllString(name, "-")
	name = dashRunRegexp.ReplaceAllString(name, "-")
	name = strings.Trim(name, "-")
	if len(name) > 56 {
		name = name[:56]
		name = strings.TrimRight(name, "-")
	}

	suffix := strings.ToLower(envUID)
	suffix = bucketRegexp.ReplaceAllString(suffix, "")
	if len(suffix) > 6 {
		suffix = suffix[:6]
	}

	if suffix == "" {
		if len(name) < 3 {
			name = (name + "env")[:3]
		}
		return name
	}
	if name == "" {
		return "dfaas-" + suffix
	}
	return name + "-" + suffix
}

// --- S3 error classifiers (ported from DFaaSOperator/dataExporter/main.go) ---

// isS3NotFound returns true for the HeadBucket "missing" surface.
func isS3NotFound(err error) bool {
	if err == nil {
		return false
	}
	var nf *s3types.NotFound
	if errors.As(err, &nf) {
		return true
	}
	var apiErr smithy.APIError
	if errors.As(err, &apiErr) {
		code := apiErr.ErrorCode()
		return code == "NotFound" || code == "NoSuchBucket" || code == "404"
	}
	return false
}

// isS3Forbidden matches a 403 response. SeaweedFS returns 403 Forbidden for
// HeadBucket on a non-existent bucket (rather than 404 NoSuchBucket), so the
// caller treats it like NotFound and proceeds to create; a real auth failure
// then surfaces on the follow-up CreateBucket/PutObject.
func isS3Forbidden(err error) bool {
	if err == nil {
		return false
	}
	var apiErr smithy.APIError
	if errors.As(err, &apiErr) {
		code := apiErr.ErrorCode()
		return code == "Forbidden" || code == "AccessDenied" || code == "403"
	}
	return false
}

// isS3OwnedByYou matches CreateBucket's idempotent "already created by us" case.
func isS3OwnedByYou(err error) bool {
	if err == nil {
		return false
	}
	var owned *s3types.BucketAlreadyOwnedByYou
	if errors.As(err, &owned) {
		return true
	}
	var apiErr smithy.APIError
	if errors.As(err, &apiErr) {
		return apiErr.ErrorCode() == "BucketAlreadyOwnedByYou"
	}
	return false
}

// isS3AlreadyExists matches CreateBucket's cross-tenant global-name collision.
func isS3AlreadyExists(err error) bool {
	if err == nil {
		return false
	}
	var exists *s3types.BucketAlreadyExists
	if errors.As(err, &exists) {
		return true
	}
	var apiErr smithy.APIError
	if errors.As(err, &apiErr) {
		return apiErr.ErrorCode() == "BucketAlreadyExists"
	}
	return false
}
