package api

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
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
// in-cluster MinIO. Environments that set no spec.s3ConfigRef fall back to it.
const DefaultS3ConfigName = "minio-default"

// minioNodePort is the NodePort the in-cluster MinIO S3 API is exposed on. The
// k6 runner lives on remote VMs that cannot resolve the internal cluster DNS,
// so asset URLs for the default MinIO are rewritten to <nodeIP>:<minioNodePort>.
const minioNodePort = "30900"

// assetTagging is applied to every uploaded object so operators can identify
// (and later sweep) k6 payload assets.
const assetTagging = "dfaas.io/asset=true"

// NodeGVR is the GVR for core/v1 Nodes, listed to derive the in-cluster MinIO
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
func (h *Handler) UploadLoadTestAsset(c *gin.Context) {
	if err := c.Request.ParseMultipartForm(32 << 20); err != nil {
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
		c.JSON(http.StatusNotFound, gin.H{"error": fmt.Sprintf("environment '%s/%s' not found: %v", namespace, environment, err)})
		return
	}
	envUID := string(envObj.GetUID())

	configName := getNestedString(envObj.Object, "spec", "s3ConfigRef", "name")
	if configName == "" {
		configName = DefaultS3ConfigName
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

	endpoint := decodeSecretValue(secret.Object, "endpoint")
	region := decodeSecretValue(secret.Object, "region")
	accessKey := decodeSecretValue(secret.Object, "access_key_id")
	secretKey := decodeSecretValue(secret.Object, "secret_access_key")
	forcePathStyle, _ := strconv.ParseBool(decodeSecretValue(secret.Object, "force_path_style"))

	// The gateway must DIAL a reachable endpoint. For the in-cluster MinIO the
	// Secret holds the internal cluster DNS, unreachable when the gateway runs
	// outside the cluster (dev mode) — resolve a node-IP:NodePort fallback.
	connectEndpoint := h.resolveConnectEndpoint(ctx, configName, endpoint)

	s3Client, err := newS3Client(ctx, region, connectEndpoint, accessKey, secretKey, forcePathStyle)
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

	publicURL := h.resolvePublicURL(ctx, configName, endpoint, bucket, key)

	c.JSON(http.StatusCreated, gin.H{
		"url":         publicURL,
		"contentType": contentType,
		"filename":    fileHeader.Filename,
	})
}

// inCluster reports whether this process runs inside a Kubernetes Pod. The
// kubelet injects KUBERNETES_SERVICE_HOST into every Pod and it is absent in
// local/dev runs — the same signal rest.InClusterConfig() keys off (see
// NewK8sClient in k8s_client.go).
func inCluster() bool {
	return os.Getenv("KUBERNETES_SERVICE_HOST") != ""
}

// resolveConnectEndpoint returns the endpoint the GATEWAY dials to reach the
// object store — auto-detected, so the common cases need no configuration:
//
//   - MINIO_ENDPOINT set            → explicit override, always wins.
//   - default in-cluster MinIO:
//   - gateway in-cluster          → the Secret's internal DNS endpoint
//     (minio.monitoring.svc…:9000) — the canonical ClusterIP path.
//   - gateway outside the cluster → http://<nodeIP>:<minioNodePort>; the
//     internal DNS would fail to resolve ("no such host"), so dial the
//     node IP + NodePort instead (reachable from outside). Falls back to
//     the Secret endpoint when no node IP can be derived.
//   - explicit external S3 config   → its own endpoint.
//
// This is distinct from resolvePublicURL (the k6-facing asset URL); the two
// endpoints are resolved independently.
func (h *Handler) resolveConnectEndpoint(ctx context.Context, configName, endpoint string) string {
	if e := strings.TrimRight(os.Getenv("MINIO_ENDPOINT"), "/"); e != "" {
		return e
	}
	if configName == DefaultS3ConfigName && !inCluster() {
		if ip := h.firstNodeIP(ctx); ip != "" {
			return fmt.Sprintf("http://%s:%s", ip, minioNodePort)
		}
		// No node IP derivable: fall through to the Secret endpoint.
	}
	return endpoint
}

// resolvePublicURL builds the externally reachable URL of an uploaded asset.
//
//   - MINIO_PUBLIC_URL set        → <MINIO_PUBLIC_URL>/<bucket>/<key>
//   - default in-cluster MinIO    → http://<nodeIP>:30900/<bucket>/<key>
//     (the internal DNS endpoint is unreachable from remote k6 VMs, so the URL
//     is rewritten to a node IP + the MinIO API NodePort)
//   - explicit external S3        → <endpoint>/<bucket>/<key>
func (h *Handler) resolvePublicURL(ctx context.Context, configName, endpoint, bucket, key string) string {
	if base := strings.TrimRight(os.Getenv("MINIO_PUBLIC_URL"), "/"); base != "" {
		return fmt.Sprintf("%s/%s/%s", base, bucket, key)
	}

	if configName == DefaultS3ConfigName {
		if ip := h.firstNodeIP(ctx); ip != "" {
			return fmt.Sprintf("http://%s:%s/%s/%s", ip, minioNodePort, bucket, key)
		}
		// Fall back to the configured endpoint when no node IP can be derived;
		// in-cluster consumers (rare) can still reach it via DNS.
	}

	return fmt.Sprintf("%s/%s/%s", strings.TrimRight(endpoint, "/"), bucket, key)
}

// firstNodeIP lists cluster Nodes and returns the first ExternalIP, falling back
// to the first InternalIP. Empty when no Node carries a usable address.
//
// NOTE: on a multi-node cluster MinIO's NodePort is reachable on every node, but
// the chosen node may not be the one actually scheduling the MinIO Pod. This is
// fine for a NodePort Service (kube-proxy forwards across nodes) but means the
// returned IP is "some" node, not necessarily the MinIO host.
func (h *Handler) firstNodeIP(ctx context.Context) string {
	nodes, err := h.client.Resource(NodeGVR).List(ctx, metav1.ListOptions{})
	if err != nil || len(nodes.Items) == 0 {
		return ""
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
					return ip
				}
			case "InternalIP":
				if internalFallback == "" {
					internalFallback = getStringFromMap(addr, "address")
				}
			}
		}
	}
	return internalFallback
}

// newS3Client builds an aws-sdk-go-v2 S3 client with static credentials, an
// optional custom BaseEndpoint (MinIO), and path-style addressing toggle.
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
func ensureBucket(ctx context.Context, client *s3.Client, bucket, region string) error {
	_, err := client.HeadBucket(ctx, &s3.HeadBucketInput{Bucket: aws.String(bucket)})
	if err == nil {
		return nil
	}
	if !isS3NotFound(err) {
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
func ensureAssetsPublicPolicy(ctx context.Context, client *s3.Client, bucket string) error {
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
// (dataExporter/main.go) so uploads land in the same bucket the exporter reads.
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

// --- S3 error classifiers (ported from dataExporter/main.go) ---

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
