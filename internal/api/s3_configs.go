package api

import (
	"context"
	"encoding/base64"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// dns1123Name is the standard k8s name regex; we use it to validate the
// user-supplied Name field (which becomes the Secret name) before talking to
// the API server. The validator covers the binding length tags; this regex
// covers character set + structure.
var dns1123Name = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`)

// ListS3Configs returns Secrets in the dfaas-s3 namespace labeled
// dfaas.io/s3-config=true. The endpoint/region fields are base64-decoded
// for display; key fields are never read or returned.
func (h *Handler) ListS3Configs(c *gin.Context) {
	ctx, cancel := context.WithTimeout(c.Request.Context(), 10*time.Second)
	defer cancel()

	result, err := h.client.Resource(SecretGVR).Namespace(S3ConfigNamespace).List(ctx, metav1.ListOptions{
		LabelSelector: fmt.Sprintf("%s=true", S3ConfigLabel),
	})
	if err != nil {
		if apierrors.IsNotFound(err) {
			c.JSON(http.StatusOK, gin.H{"s3Configs": []S3ConfigSummary{}, "count": 0})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("list s3-configs: %v", err)})
		return
	}

	out := make([]S3ConfigSummary, 0, len(result.Items))
	for _, item := range result.Items {
		out = append(out, mapS3ConfigSummary(item))
	}

	c.JSON(http.StatusOK, gin.H{"s3Configs": out, "count": len(out)})
}

// GetS3Config returns endpoint, region, forcePathStyle, createdAt for one
// Secret. Access/secret keys are never returned, even if present.
func (h *Handler) GetS3Config(c *gin.Context) {
	name := c.Param("name")

	ctx, cancel := context.WithTimeout(c.Request.Context(), 10*time.Second)
	defer cancel()

	obj, err := h.client.Resource(SecretGVR).Namespace(S3ConfigNamespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		if apierrors.IsNotFound(err) {
			c.JSON(http.StatusNotFound, gin.H{"error": fmt.Sprintf("s3-config '%s' not found", name)})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("get s3-config: %v", err)})
		return
	}

	summary := mapS3ConfigSummary(*obj)
	fps := decodeSecretValue(obj.Object, "force_path_style")
	detail := S3ConfigDetail{
		S3ConfigSummary: summary,
		ForcePathStyle:  fps == "true",
	}
	c.JSON(http.StatusOK, detail)
}

// CreateS3Config writes a new Opaque Secret in dfaas-s3.
// Name must be DNS-1123 (validated explicitly) and is the Secret's
// metadata.name verbatim. Labels: dfaas.io/s3-config=true.
func (h *Handler) CreateS3Config(c *gin.Context) {
	var req CreateS3Config
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("invalid body: %v", err)})
		return
	}

	// Reject control characters / bracket injection up front — these would
	// produce confusing API-server errors and there's no legit use for them
	// in a Secret name.
	if strings.ContainsAny(req.Name, "]\n\r\t") {
		c.JSON(http.StatusBadRequest, gin.H{"error": "name contains invalid characters"})
		return
	}
	if !dns1123Name.MatchString(req.Name) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "name must match DNS-1123 (lowercase alphanumeric and '-', start/end alphanumeric)"})
		return
	}

	forcePathStyle := "false"
	if req.ForcePathStyle {
		forcePathStyle = "true"
	}

	obj := &unstructured.Unstructured{
		Object: map[string]interface{}{
			"apiVersion": "v1",
			"kind":       "Secret",
			"type":       "Opaque",
			"metadata": map[string]interface{}{
				"name":      req.Name,
				"namespace": S3ConfigNamespace,
				"labels": map[string]interface{}{
					S3ConfigLabel: "true",
				},
			},
			"stringData": map[string]interface{}{
				"endpoint":          req.Endpoint,
				"region":            req.Region,
				"access_key_id":     req.AccessKeyId,
				"secret_access_key": req.SecretAccessKey,
				"force_path_style":  forcePathStyle,
			},
		},
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), 15*time.Second)
	defer cancel()

	created, err := h.client.Resource(SecretGVR).Namespace(S3ConfigNamespace).Create(ctx, obj, metav1.CreateOptions{})
	if err != nil {
		switch {
		case apierrors.IsAlreadyExists(err):
			c.JSON(http.StatusConflict, gin.H{"error": fmt.Sprintf("s3-config '%s' already exists", req.Name)})
		case apierrors.IsNotFound(err):
			// Most likely the dfaas-s3 namespace doesn't exist yet — operator
			// owns its bootstrap; surface a clear message.
			c.JSON(http.StatusFailedDependency, gin.H{"error": fmt.Sprintf("namespace '%s' missing; the operator must bootstrap it first", S3ConfigNamespace)})
		default:
			writeK8sError(c, err, fmt.Sprintf("s3-config '%s'", req.Name))
		}
		return
	}

	c.JSON(http.StatusCreated, S3ConfigDetail{
		S3ConfigSummary: mapS3ConfigSummary(*created),
		ForcePathStyle:  req.ForcePathStyle,
	})
}

// DeleteS3Config removes the Secret. Environments still referencing it will
// surface the failure via the operator's LoadTest reconcile (out of scope
// here — reference guard deferred per plan).
func (h *Handler) DeleteS3Config(c *gin.Context) {
	name := c.Param("name")

	ctx, cancel := context.WithTimeout(c.Request.Context(), 10*time.Second)
	defer cancel()

	if err := h.client.Resource(SecretGVR).Namespace(S3ConfigNamespace).Delete(ctx, name, metav1.DeleteOptions{}); err != nil {
		if apierrors.IsNotFound(err) {
			c.JSON(http.StatusNotFound, gin.H{"error": fmt.Sprintf("s3-config '%s' not found", name)})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("delete s3-config: %v", err)})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": fmt.Sprintf("s3-config '%s' deletion requested", name)})
}

// mapS3ConfigSummary projects a Secret unstructured object onto S3ConfigSummary,
// base64-decoding the endpoint/region fields from data.
func mapS3ConfigSummary(item unstructured.Unstructured) S3ConfigSummary {
	return S3ConfigSummary{
		Name:      item.GetName(),
		Endpoint:  decodeSecretValue(item.Object, "endpoint"),
		Region:    decodeSecretValue(item.Object, "region"),
		CreatedAt: item.GetCreationTimestamp().Time,
	}
}

// decodeSecretValue reads data[key] from a Secret-shaped unstructured map and
// returns the decoded string. Falls back to stringData[key] if present (only
// the gateway's own create path uses stringData on the way in; the API server
// normalises everything to data on read).
func decodeSecretValue(obj map[string]interface{}, key string) string {
	if data, ok := obj["data"].(map[string]interface{}); ok {
		if raw, ok := data[key].(string); ok && raw != "" {
			if decoded, err := base64.StdEncoding.DecodeString(raw); err == nil {
				return string(decoded)
			}
		}
	}
	if sd, ok := obj["stringData"].(map[string]interface{}); ok {
		if raw, ok := sd[key].(string); ok {
			return raw
		}
	}
	return ""
}
