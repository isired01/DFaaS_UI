package api

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/aws/aws-sdk-go-v2/service/s3"
	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"
	smithy "github.com/aws/smithy-go"
	"github.com/gin-gonic/gin"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"
)

// The asset-upload path was 0% tested because newS3Client returned a concrete
// *s3.Client and every consumer took that concrete type -- so the whole path
// needed a live S3 to execute once, while the Kubernetes half of the same
// handler was already fakeable. What that hid is the file's most load-bearing
// rule, which existed only as a comment: SeaweedFS answers HeadBucket with 403
// Forbidden for a bucket that does not exist yet.

// recordingStore implements objectStore and records every call.
type recordingStore struct {
	headErr   error
	created   []string
	policies  map[string]string
	puts      []*s3.PutObjectInput
	headCalls int
}

func (r *recordingStore) HeadBucket(_ context.Context, _ *s3.HeadBucketInput, _ ...func(*s3.Options)) (*s3.HeadBucketOutput, error) {
	r.headCalls++
	if r.headErr != nil {
		return nil, r.headErr
	}
	return &s3.HeadBucketOutput{}, nil
}

func (r *recordingStore) CreateBucket(_ context.Context, in *s3.CreateBucketInput, _ ...func(*s3.Options)) (*s3.CreateBucketOutput, error) {
	r.created = append(r.created, *in.Bucket)
	return &s3.CreateBucketOutput{}, nil
}

func (r *recordingStore) PutBucketPolicy(_ context.Context, in *s3.PutBucketPolicyInput, _ ...func(*s3.Options)) (*s3.PutBucketPolicyOutput, error) {
	if r.policies == nil {
		r.policies = map[string]string{}
	}
	r.policies[*in.Bucket] = *in.Policy
	return &s3.PutBucketPolicyOutput{}, nil
}

func (r *recordingStore) PutObject(_ context.Context, in *s3.PutObjectInput, _ ...func(*s3.Options)) (*s3.PutObjectOutput, error) {
	r.puts = append(r.puts, in)
	return &s3.PutObjectOutput{}, nil
}

// --- fixtures -------------------------------------------------------------

func assetEnvObj(name, uid, s3ConfigRef string) *unstructured.Unstructured {
	spec := map[string]interface{}{"nodes": []interface{}{}}
	if s3ConfigRef != "" {
		spec["s3ConfigRef"] = map[string]interface{}{"name": s3ConfigRef}
	}
	return &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "dfaas.dfaas.io/v1",
		"kind":       "Environment",
		"metadata": map[string]interface{}{
			"name": name, "namespace": "default", "uid": uid,
		},
		"spec": spec,
	}}
}

// s3ConfigSecret holds base64 values, as a real Secret does. Synthetic
// credentials.
func s3ConfigSecret(name, endpoint string) *unstructured.Unstructured {
	b64 := func(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }
	return &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "v1",
		"kind":       "Secret",
		"metadata":   map[string]interface{}{"name": name, "namespace": S3ConfigNamespace},
		"data": map[string]interface{}{
			"endpoint":          b64(endpoint),
			"region":            b64("us-east-1"),
			"access_key_id":     b64("test"),
			"secret_access_key": b64("test-secret"),
			"force_path_style":  b64("true"),
		},
	}}
}

// nodeObj carries ONLY an InternalIP: the common single-node lab cluster, and
// the case the public URL has to work for.
func nodeObj(name, internalIP string) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "v1",
		"kind":       "Node",
		"metadata":   map[string]interface{}{"name": name},
		"status": map[string]interface{}{"addresses": []interface{}{
			map[string]interface{}{"type": "Hostname", "address": name},
			map[string]interface{}{"type": "InternalIP", "address": internalIP},
		}},
	}}
}

func assetHandler(store *recordingStore, addr assetAddressing, objs ...runtime.Object) *Handler {
	s := runtime.NewScheme()
	listKinds := map[schema.GroupVersionResource]string{
		EnvironmentGVR: "EnvironmentList",
		SecretGVR:      "SecretList",
		NodeGVR:        "NodeList",
	}
	return &Handler{
		client:     dynamicfake.NewSimpleDynamicClientWithCustomListKinds(s, listKinds, objs...),
		addressing: addr,
		newStore: func(_ context.Context, _, _, _, _ string, _ bool) (objectStore, error) {
			return store, nil
		},
	}
}

// upload POSTs a multipart body at the handler and returns the recorder.
func upload(t *testing.T, h *Handler, namespace, environment, filename string, payload []byte) *httptest.ResponseRecorder {
	t.Helper()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.POST("/loadtests/assets", h.UploadLoadTestAsset)

	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	if err := w.WriteField("namespace", namespace); err != nil {
		t.Fatal(err)
	}
	if err := w.WriteField("environment", environment); err != nil {
		t.Fatal(err)
	}
	part, err := w.CreateFormFile("file", filename)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(payload); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPost, "/loadtests/assets", &body)
	req.Header.Set("Content-Type", w.FormDataContentType())
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	return rec
}

// pngPayload is a minimal PNG header, enough for http.DetectContentType.
var pngPayload = append([]byte("\x89PNG\r\n\x1a\n"), bytes.Repeat([]byte{0}, 32)...)

// --- the SeaweedFS 403 quirk ---------------------------------------------

func TestUploadTreatsHeadBucketForbiddenAsMissing(t *testing.T) {
	// SeaweedFS answers 403, not 404, for a bucket that does not exist yet. A
	// genuine auth failure deliberately falls through to CreateBucket, where it
	// surfaces. Nothing pinned this.
	// What the SDK actually surfaces: a smithy APIError. SeaweedFS answers
	// HeadBucket with 403/Forbidden; AWS with 404/NotFound.
	cases := map[string]error{
		"NotFound":     &s3types.NotFound{},
		"Forbidden":    &smithy.GenericAPIError{Code: "Forbidden", Message: "Forbidden"},
		"AccessDenied": &smithy.GenericAPIError{Code: "AccessDenied", Message: "Access Denied"},
	}

	for name, headErr := range cases {
		t.Run(name, func(t *testing.T) {
			st := &recordingStore{headErr: headErr}
			h := assetHandler(st, assetAddressing{},
				assetEnvObj("bari", "uid-fake-1", ""),
				s3ConfigSecret(DefaultS3ConfigName, "http://seaweedfs-all-in-one.monitoring.svc.cluster.local:8333"),
				nodeObj("node-a", "192.0.2.10"),
			)

			rec := upload(t, h, "default", "bari", "logo.png", pngPayload)
			if rec.Code != http.StatusCreated {
				t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
			}
			if len(st.created) != 1 {
				t.Errorf("CreateBucket was called %d times, want 1 — a %s HeadBucket must mean \"missing\"",
					len(st.created), name)
			}
			if len(st.puts) != 1 {
				t.Fatalf("PutObject was called %d times, want 1", len(st.puts))
			}
		})
	}
}

func TestUploadSkipsCreateWhenTheBucketExists(t *testing.T) {
	store := &recordingStore{}
	h := assetHandler(store, assetAddressing{},
		assetEnvObj("bari", "uid-fake-1", ""),
		s3ConfigSecret(DefaultS3ConfigName, "http://seaweedfs:8333"),
		nodeObj("node-a", "192.0.2.10"),
	)
	if rec := upload(t, h, "default", "bari", "logo.png", pngPayload); rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if len(store.created) != 0 {
		t.Errorf("CreateBucket called on an existing bucket: %v", store.created)
	}
}

// A HeadBucket failure that is neither missing nor forbidden must not be
// mistaken for "create it".
func TestUploadReportsAnUnexpectedHeadBucketError(t *testing.T) {
	store := &recordingStore{headErr: errors.New("dial tcp: connection refused")}
	h := assetHandler(store, assetAddressing{},
		assetEnvObj("bari", "uid-fake-1", ""),
		s3ConfigSecret(DefaultS3ConfigName, "http://seaweedfs:8333"),
		nodeObj("node-a", "192.0.2.10"),
	)
	rec := upload(t, h, "default", "bari", "logo.png", pngPayload)
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want 500; body = %s", rec.Code, rec.Body.String())
	}
	if len(store.created) != 0 {
		t.Errorf("CreateBucket must not run after an unexpected HeadBucket error: %v", store.created)
	}
}

// --- what the k6 runners are handed --------------------------------------

func TestUploadReturnsANodePortURLForTheDefaultConfig(t *testing.T) {
	store := &recordingStore{}
	h := assetHandler(store, assetAddressing{},
		assetEnvObj("bari", "uid-fake-1", ""),
		// The Secret's internal DNS endpoint is unreachable from a k6 VM, so
		// the returned URL must NOT be built from it.
		s3ConfigSecret(DefaultS3ConfigName, "http://seaweedfs-all-in-one.monitoring.svc.cluster.local:8333"),
		nodeObj("node-a", "192.0.2.10"),
	)

	rec := upload(t, h, "default", "bari", "logo.png", pngPayload)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}

	body := decodeUpload(t, rec)

	wantPrefix := "http://192.0.2.10:" + seaweedfsNodePort + "/bari-uid-fa/assets/"
	if !strings.HasPrefix(body.URL, wantPrefix) {
		t.Errorf("url = %q, want prefix %q", body.URL, wantPrefix)
	}
	if strings.Contains(body.URL, "svc.cluster.local") {
		t.Errorf("url = %q: the internal DNS endpoint is unreachable from a k6 VM", body.URL)
	}
	if !strings.HasSuffix(body.URL, "logo.png") {
		t.Errorf("url = %q, want the sanitised filename at the end", body.URL)
	}
	if body.ContentType != "image/png" {
		t.Errorf("contentType = %q, want image/png (sniffed, not the multipart header)", body.ContentType)
	}
	if body.Filename != "logo.png" {
		t.Errorf("filename = %q, want the original name", body.Filename)
	}

	// The in-cluster SeaweedFS is relocatable: a runner given DFAAS_ASSET_BASE
	// fetches the same object off its own management address.
	if !body.Relocatable {
		t.Error("relocatable = false, want true for the in-cluster SeaweedFS")
	}
	if !strings.HasPrefix(body.Path, "/bari-uid-fa/assets/") || !strings.HasSuffix(body.Path, "logo.png") {
		t.Errorf("path = %q, want /bari-uid-fa/assets/<uuid>-logo.png", body.Path)
	}
	if !strings.HasSuffix(body.URL, body.Path) {
		t.Errorf("url = %q does not end with path %q: the fallback and the relocated fetch would name different objects", body.URL, body.Path)
	}
}

// decodeUpload decodes a 201 body, and fails when relocatable is missing: the
// wire always states relocatability explicitly (no omitempty), even though the
// SPA treats only true as relocatable and a missing key reads as false there.
func decodeUpload(t *testing.T, rec *httptest.ResponseRecorder) UploadAssetResponse {
	t.Helper()
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(rec.Body.Bytes(), &raw); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if _, ok := raw["relocatable"]; !ok {
		t.Errorf("response has no relocatable key: %s", rec.Body.String())
	}
	if p, ok := raw["path"]; ok && string(p) == `""` {
		t.Errorf("response carries an empty path; it must be absent instead: %s", rec.Body.String())
	}
	var body UploadAssetResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	return body
}

// An external config is not relocatable, and the two SeaweedFS overrides do
// not apply to it: before, SEAWEEDFS_PUBLIC_URL moved its URL onto SeaweedFS
// and SEAWEEDFS_ENDPOINT sent its credentials and objects there.
func TestUploadToAnExternalConfigKeepsItsOwnEndpoint(t *testing.T) {
	store := &recordingStore{}
	h := assetHandler(store, assetAddressing{
		PublicOverride:  "http://lab.example:30900",
		ConnectOverride: "http://localhost:8333",
	},
		assetEnvObj("bari", "uid-fake-1", "my-aws"),
		s3ConfigSecret("my-aws", "https://s3.example"),
		// no Node: an external config never needs one
	)
	var dialed string
	h.newStore = func(_ context.Context, _, endpoint, _, _ string, _ bool) (objectStore, error) {
		dialed = endpoint
		return store, nil
	}

	rec := upload(t, h, "default", "bari", "logo.png", pngPayload)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	body := decodeUpload(t, rec)

	if dialed != "https://s3.example" {
		t.Errorf("dialed %q, want the config's own endpoint", dialed)
	}
	if !strings.HasPrefix(body.URL, "https://s3.example/bari-uid-fa/assets/") {
		t.Errorf("url = %q, want it on the config's own endpoint", body.URL)
	}
	if body.Relocatable {
		t.Error("relocatable = true, want false: the object does not live on the management node")
	}
	if strings.Contains(rec.Body.String(), `"path"`) {
		t.Errorf("a non-relocatable upload must carry no path: %s", rec.Body.String())
	}
}

// An external config may have no endpoint (the AWS default, which the registry
// accepts). Its url used to come back relative, "/<bucket>/<key>", with a 201,
// and every k6 runner then failed the fetch. The upload is refused instead,
// before the bucket or its public policy is touched, whatever overrides are set.
func TestUploadRefusesAnExternalConfigWithNoAbsoluteEndpoint(t *testing.T) {
	cases := map[string]string{
		"no endpoint":       "",
		"no scheme":         "s3.example",
		"no host":           "https://",
		"not http or https": "ftp://s3.example",
	}
	for name, endpoint := range cases {
		t.Run(name, func(t *testing.T) {
			store := &recordingStore{}
			h := assetHandler(store, assetAddressing{PublicOverride: "http://lab.example:30900", InCluster: true},
				assetEnvObj("bari", "uid-fake-1", "my-aws"),
				s3ConfigSecret("my-aws", endpoint),
			)
			rec := upload(t, h, "default", "bari", "logo.png", pngPayload)
			if rec.Code != http.StatusConflict {
				t.Fatalf("status = %d, want 409; body = %s", rec.Code, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), "my-aws") {
				t.Errorf("the error must name the config: %s", rec.Body.String())
			}
			if store.headCalls != 0 || len(store.created) != 0 || len(store.policies) != 0 || len(store.puts) != 0 {
				t.Errorf("nothing may be written: HeadBucket %d, CreateBucket %v, policies %v, PutObject %d",
					store.headCalls, store.created, store.policies, len(store.puts))
			}
		})
	}
}

// SEAWEEDFS_PUBLIC_URL sets the fallback URL only; the asset stays relocatable.
func TestUploadWithThePublicOverrideIsStillRelocatable(t *testing.T) {
	store := &recordingStore{}
	h := assetHandler(store, assetAddressing{PublicOverride: "http://192.0.2.1:30900", InCluster: true},
		assetEnvObj("bari", "uid-fake-1", ""),
		s3ConfigSecret(DefaultS3ConfigName, "http://seaweedfs:8333"),
	)
	rec := upload(t, h, "default", "bari", "logo.png", pngPayload)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	body := decodeUpload(t, rec)

	if !body.Relocatable || !strings.HasPrefix(body.Path, "/bari-uid-fa/assets/") {
		t.Errorf("relocatable = %v, path = %q; want a relocatable asset under /bari-uid-fa/assets/", body.Relocatable, body.Path)
	}
	if body.URL != "http://192.0.2.1:30900"+body.Path {
		t.Errorf("url = %q, want the override followed by path %q", body.URL, body.Path)
	}
}

func TestUploadBracketsAnIPv6NodeAddress(t *testing.T) {
	store := &recordingStore{}
	h := assetHandler(store, assetAddressing{},
		assetEnvObj("bari", "uid-fake-1", ""),
		s3ConfigSecret(DefaultS3ConfigName, "http://seaweedfs:8333"),
		nodeObj("node-a", "2001:db8::10"),
	)
	var dialed string
	h.newStore = func(_ context.Context, _, endpoint, _, _ string, _ bool) (objectStore, error) {
		dialed = endpoint
		return store, nil
	}

	rec := upload(t, h, "default", "bari", "logo.png", pngPayload)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	body := decodeUpload(t, rec)

	if want := "http://[2001:db8::10]:" + seaweedfsNodePort + "/bari-uid-fa/assets/"; !strings.HasPrefix(body.URL, want) {
		t.Errorf("url = %q, want prefix %q", body.URL, want)
	}
	if want := "http://[2001:db8::10]:" + seaweedfsNodePort; dialed != want {
		t.Errorf("dialed %q, want %q", dialed, want)
	}
}

func TestUploadTagsTheObjectAndSetsTheSniffedType(t *testing.T) {
	store := &recordingStore{}
	h := assetHandler(store, assetAddressing{},
		assetEnvObj("bari", "uid-fake-1", ""),
		s3ConfigSecret(DefaultS3ConfigName, "http://seaweedfs:8333"),
		nodeObj("node-a", "192.0.2.10"),
	)
	if rec := upload(t, h, "default", "bari", "logo.png", pngPayload); rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}

	if len(store.puts) != 1 {
		t.Fatalf("PutObject calls = %d, want 1", len(store.puts))
	}
	put := store.puts[0]
	if put.Tagging == nil || *put.Tagging != assetTagging {
		t.Errorf("Tagging = %v, want %q", put.Tagging, assetTagging)
	}
	if put.ContentType == nil || *put.ContentType != "image/png" {
		t.Errorf("ContentType = %v, want image/png", put.ContentType)
	}
	if put.Key == nil || !strings.HasPrefix(*put.Key, "assets/") {
		t.Errorf("Key = %v, want the assets/ prefix the bucket policy grants", put.Key)
	}

	// The anonymous-read policy is what lets a k6 VM fetch the object at all,
	// and it must stay scoped to assets/*.
	policy, ok := store.policies["bari-uid-fa"]
	if !ok {
		t.Fatalf("no bucket policy was set; got %v", store.policies)
	}
	if !strings.Contains(policy, "arn:aws:s3:::bari-uid-fa/assets/*") {
		t.Errorf("policy does not scope to assets/*:\n%s", policy)
	}
	if !strings.Contains(policy, `"Principal": "*"`) {
		t.Errorf("policy is not anonymous-read:\n%s", policy)
	}
}

// No node address and no override: the upload must be refused, not answered
// with a URL that only fails later on a remote k6 VM.
func TestUploadRefusesWhenNoNodeAddressIsAvailable(t *testing.T) {
	store := &recordingStore{}
	h := assetHandler(store, assetAddressing{},
		assetEnvObj("bari", "uid-fake-1", ""),
		s3ConfigSecret(DefaultS3ConfigName, "http://seaweedfs:8333"),
		// no Node objects at all
	)
	rec := upload(t, h, "default", "bari", "logo.png", pngPayload)
	if rec.Code != http.StatusBadGateway {
		t.Errorf("status = %d, want 502; body = %s", rec.Code, rec.Body.String())
	}
	if len(store.puts) != 0 {
		t.Error("nothing must be uploaded when the resulting URL would be unreachable")
	}
}

func TestUploadRejectsAMissingS3Config(t *testing.T) {
	h := assetHandler(&recordingStore{}, assetAddressing{PublicOverride: "http://lab.example:30900"},
		assetEnvObj("bari", "uid-fake-1", "does-not-exist"),
	)
	rec := upload(t, h, "default", "bari", "logo.png", pngPayload)
	if rec.Code != http.StatusConflict {
		t.Errorf("status = %d, want 409; body = %s", rec.Code, rec.Body.String())
	}
}

// --- the addressing algebra, with no environment -------------------------

func TestAssetAddressing(t *testing.T) {
	const dnsEndpoint = "http://seaweedfs-all-in-one.monitoring.svc.cluster.local:8333"

	t.Run("in-cluster dials the Secret's internal DNS", func(t *testing.T) {
		a := assetAddressing{InCluster: true}
		if got := a.ConnectEndpoint(DefaultS3ConfigName, dnsEndpoint, "192.0.2.10"); got != dnsEndpoint {
			t.Errorf("ConnectEndpoint = %q, want the internal DNS", got)
		}
	})

	t.Run("outside the cluster dials the node NodePort", func(t *testing.T) {
		a := assetAddressing{}
		want := "http://192.0.2.10:" + seaweedfsNodePort
		if got := a.ConnectEndpoint(DefaultS3ConfigName, dnsEndpoint, "192.0.2.10"); got != want {
			t.Errorf("ConnectEndpoint = %q, want %q — the internal DNS would not resolve", got, want)
		}
	})

	t.Run("the connect override wins for the default config", func(t *testing.T) {
		a := assetAddressing{ConnectOverride: "http://override:8333", InCluster: true}
		if got := a.ConnectEndpoint(DefaultS3ConfigName, dnsEndpoint, "192.0.2.10"); got != "http://override:8333" {
			t.Errorf("ConnectEndpoint = %q, want the override", got)
		}
	})

	t.Run("an external S3 config uses its own endpoint", func(t *testing.T) {
		a := assetAddressing{}
		const aws = "https://s3.eu-west-1.amazonaws.com"
		if got := a.ConnectEndpoint("my-aws", aws, "192.0.2.10"); got != aws {
			t.Errorf("ConnectEndpoint = %q, want the config's own endpoint", got)
		}
	})

	t.Run("the public URL override wins", func(t *testing.T) {
		a := assetAddressing{PublicOverride: "http://lab.example:30900"}
		want := "http://lab.example:30900/bucket/assets/key.png"
		if got := a.PublicURL(DefaultS3ConfigName, dnsEndpoint, "bucket", "assets/key.png", "192.0.2.10"); got != want {
			t.Errorf("PublicURL = %q, want %q", got, want)
		}
	})

	t.Run("the public URL never uses the internal DNS for the default config", func(t *testing.T) {
		a := assetAddressing{InCluster: true}
		want := "http://192.0.2.10:" + seaweedfsNodePort + "/bucket/assets/key.png"
		if got := a.PublicURL(DefaultS3ConfigName, dnsEndpoint, "bucket", "assets/key.png", "192.0.2.10"); got != want {
			t.Errorf("PublicURL = %q, want %q — a k6 VM cannot resolve cluster DNS", got, want)
		}
	})

	t.Run("an IPv6 node IP is bracketed", func(t *testing.T) {
		a := assetAddressing{}
		wantPublic := "http://[2001:db8::1]:" + seaweedfsNodePort + "/bucket/assets/key.png"
		if got := a.PublicURL(DefaultS3ConfigName, dnsEndpoint, "bucket", "assets/key.png", "2001:db8::1"); got != wantPublic {
			t.Errorf("PublicURL = %q, want %q", got, wantPublic)
		}
		wantConnect := "http://[2001:db8::1]:" + seaweedfsNodePort
		if got := a.ConnectEndpoint(DefaultS3ConfigName, dnsEndpoint, "2001:db8::1"); got != wantConnect {
			t.Errorf("ConnectEndpoint = %q, want %q", got, wantConnect)
		}
	})

	t.Run("an external config ignores both SeaweedFS overrides", func(t *testing.T) {
		a := assetAddressing{PublicOverride: "http://lab.example:30900", ConnectOverride: "http://localhost:8333"}
		const ext = "https://s3.example/"
		if got := a.ConnectEndpoint("my-aws", ext, "192.0.2.10"); got != ext {
			t.Errorf("ConnectEndpoint = %q, want the config's own endpoint", got)
		}
		if got, want := a.PublicURL("my-aws", ext, "bucket", "assets/key.png", "192.0.2.10"), "https://s3.example/bucket/assets/key.png"; got != want {
			t.Errorf("PublicURL = %q, want %q", got, want)
		}
	})

	// The relocated fetch is DFAAS_ASSET_BASE + path, the fallback is url: on
	// every branch they must name the same object.
	t.Run("every public URL ends with the asset path", func(t *testing.T) {
		path := assetPath("bucket", "assets/key.png")
		if path != "/bucket/assets/key.png" {
			t.Fatalf("assetPath = %q, want /bucket/assets/key.png", path)
		}
		for name, got := range map[string]string{
			"override":        assetAddressing{PublicOverride: "http://x"}.PublicURL(DefaultS3ConfigName, dnsEndpoint, "bucket", "assets/key.png", "192.0.2.10"),
			"node IP":         assetAddressing{}.PublicURL(DefaultS3ConfigName, dnsEndpoint, "bucket", "assets/key.png", "192.0.2.10"),
			"no node IP":      assetAddressing{}.PublicURL(DefaultS3ConfigName, dnsEndpoint, "bucket", "assets/key.png", ""),
			"external config": assetAddressing{}.PublicURL("my-aws", "https://s3.example", "bucket", "assets/key.png", "192.0.2.10"),
		} {
			if !strings.HasSuffix(got, path) {
				t.Errorf("%s: PublicURL = %q does not end with %q", name, got, path)
			}
		}
	})

	t.Run("Relocatable", func(t *testing.T) {
		cases := []struct {
			name       string
			addr       assetAddressing
			configName string
			want       bool
		}{
			{"default config, no overrides", assetAddressing{}, DefaultS3ConfigName, true},
			{"default config, public override", assetAddressing{PublicOverride: "http://x"}, DefaultS3ConfigName, true},
			{"default config, connect override", assetAddressing{ConnectOverride: "http://y"}, DefaultS3ConfigName, true},
			{"default config, in-cluster", assetAddressing{InCluster: true}, DefaultS3ConfigName, true},
			{"an external config", assetAddressing{}, "my-aws", false},
			{"an external config with every override", assetAddressing{PublicOverride: "http://x", ConnectOverride: "http://y", InCluster: true}, "my-aws", false},
		}
		for _, tc := range cases {
			if got := tc.addr.Relocatable(tc.configName); got != tc.want {
				t.Errorf("%s: Relocatable = %v, want %v", tc.name, got, tc.want)
			}
		}
	})

	t.Run("NeedsNodeIP", func(t *testing.T) {
		cases := []struct {
			name       string
			addr       assetAddressing
			configName string
			want       bool
		}{
			{"default config, no overrides", assetAddressing{}, DefaultS3ConfigName, true},
			{"default config, in-cluster but no public override", assetAddressing{InCluster: true}, DefaultS3ConfigName, true},
			{"default config, public override only, outside", assetAddressing{PublicOverride: "http://x"}, DefaultS3ConfigName, true},
			{"default config, public override, in-cluster", assetAddressing{PublicOverride: "http://x", InCluster: true}, DefaultS3ConfigName, false},
			{"default config, both overrides", assetAddressing{PublicOverride: "http://x", ConnectOverride: "http://y"}, DefaultS3ConfigName, false},
			{"an external config never needs a node IP", assetAddressing{}, "my-aws", false},
		}
		for _, tc := range cases {
			if got := tc.addr.NeedsNodeIP(tc.configName); got != tc.want {
				t.Errorf("%s: NeedsNodeIP = %v, want %v", tc.name, got, tc.want)
			}
		}
	})
}

// --- bucketNameFor: the same golden table as the exporter ---------------
//
// bucketNameFor is copied from DFaaSOperator/dataExporter/main.go so uploads
// land in the bucket the exporter reads, and the table below copies the one in
// DFaaSOperator/dataExporter/main_test.go. Nothing compares the two copies:
// change both repos together.

func TestBucketNameForMatchesTheExporter(t *testing.T) {
	cases := []struct {
		name            string
		envName, envUID string
		want            string
	}{
		{
			name:    "the ordinary case: name plus six hex of the UID",
			envName: "bari", envUID: "abcdef12-3456-7890-abcd-ef1234567890",
			want: "bari-abcdef",
		},
		{
			name:    "uppercase and separators are folded",
			envName: "Bari_Test.Env", envUID: "ABCDEF12-3456",
			want: "bari-test-env-abcdef",
		},
		{
			name:    "runs of dashes collapse and edges are trimmed",
			envName: "--bari__test--", envUID: "abcdef12",
			want: "bari-test-abcdef",
		},
		{
			name:    "a long name is clamped so the total stays within 63",
			envName: strings.Repeat("a", 80), envUID: "abcdef12",
			want: strings.Repeat("a", 56) + "-abcdef",
		},
		{
			name:    "clamping does not leave a dangling dash",
			envName: strings.Repeat("a", 56) + "-bbbb", envUID: "abcdef12",
			want: strings.Repeat("a", 56) + "-abcdef",
		},
		{
			name:    "no UID: the name is padded to S3's three-char minimum",
			envName: "ab", envUID: "",
			want: "abe",
		},
		{
			name:    "no UID and a long enough name is returned as is",
			envName: "bari", envUID: "",
			want: "bari",
		},
		{
			name:    "a name that sanitises to nothing falls back to a stable prefix",
			envName: "___", envUID: "abcdef12",
			want: "dfaas-abcdef",
		},
		{
			name:    "a short UID is used as-is rather than padded",
			envName: "bari", envUID: "ab",
			want: "bari-ab",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := bucketNameFor(tc.envName, tc.envUID)
			if got != tc.want {
				t.Errorf("bucketNameFor(%q, %q) = %q, want %q", tc.envName, tc.envUID, got, tc.want)
			}
			if len(got) < 3 || len(got) > 63 {
				t.Errorf("%q is %d chars; S3 allows 3-63", got, len(got))
			}
			if strings.HasPrefix(got, "-") || strings.HasSuffix(got, "-") {
				t.Errorf("%q must not start or end with a dash", got)
			}
			for _, r := range got {
				if !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '-') {
					t.Errorf("%q contains %q, which S3 rejects", got, r)
					break
				}
			}
		})
	}
}
