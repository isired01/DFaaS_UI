package api

import (
	"context"
	"encoding/base64"
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

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
		// No IsNotFound branch: a namespaced List of a missing namespace returns
		// an empty 200, never a 404.
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("list s3-configs: %v", err)})
		return
	}

	out := make([]S3ConfigSummary, 0, len(result.Items))
	for _, item := range result.Items {
		out = append(out, mapS3ConfigSummary(item))
	}

	c.JSON(http.StatusOK, out)
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

	fps, err := decodeSecretValue(obj.Object, "force_path_style")
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("s3-config '%s': %v", name, err)})
		return
	}
	detail := S3ConfigDetail{
		S3ConfigSummary: mapS3ConfigSummary(*obj),
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

	if !dns1123Re.MatchString(req.Name) {
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

	// The built-in SeaweedFS config is the implicit sink for every Environment
	// without an explicit s3ConfigRef, and the operator only recreates it at
	// startup — deleting it silently breaks exports until the operator restarts.
	// The UI hides the button; enforce it here too, since the API is reachable
	// on its own.
	if name == DefaultS3ConfigName {
		c.JSON(http.StatusForbidden, gin.H{"error": fmt.Sprintf("s3-config '%s' is the built-in default and cannot be deleted", name)})
		return
	}

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
// base64-decoding the endpoint/region fields from data. A corrupt field is
// logged and rendered as empty: this is a display path, and failing the whole
// listing over one broken Secret would hide the healthy ones.
func mapS3ConfigSummary(item unstructured.Unstructured) S3ConfigSummary {
	endpoint, err := decodeSecretValue(item.Object, "endpoint")
	if err != nil {
		log.Printf("s3-config '%s': %v", item.GetName(), err)
	}
	region, rerr := decodeSecretValue(item.Object, "region")
	if rerr != nil {
		log.Printf("s3-config '%s': %v", item.GetName(), rerr)
	}
	return S3ConfigSummary{
		Name:      item.GetName(),
		Endpoint:  endpoint,
		Region:    region,
		CreatedAt: item.GetCreationTimestamp().Time,
	}
}

// decodeSecretValue reads data[key] from a Secret-shaped unstructured map and
// returns the decoded string.
//
// A corrupt base64 payload comes back as an error naming the field rather than
// as an empty string: silently blanking a credential surfaces much later as an
// opaque S3 "access denied", with nothing pointing at the real cause.
func decodeSecretValue(obj map[string]interface{}, key string) (string, error) {
	if data, ok := obj["data"].(map[string]interface{}); ok {
		if raw, ok := data[key].(string); ok && raw != "" {
			decoded, err := base64.StdEncoding.DecodeString(raw)
			if err != nil {
				return "", fmt.Errorf("field %q is not valid base64: %w", key, err)
			}
			return string(decoded), nil
		}
	}
	return "", nil
}
