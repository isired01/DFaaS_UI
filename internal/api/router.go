package api

import (
	"fmt"
	"net/http"

	"github.com/gin-gonic/gin"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/client-go/dynamic"
)

// Handler wires the dynamic Kubernetes client into the HTTP layer.
type Handler struct {
	client dynamic.Interface
}

// NewHandler builds a Handler bound to the provided dynamic client.
func NewHandler(client dynamic.Interface) *Handler {
	return &Handler{client: client}
}

// writeK8sError maps a Kubernetes API error to a JSON gin response.
// resource is a human descriptor like "environment 'ns/name'".
func writeK8sError(c *gin.Context, err error, resource string) {
	switch {
	case apierrors.IsNotFound(err):
		c.JSON(http.StatusNotFound, gin.H{"error": fmt.Sprintf("%s not found", resource)})
	case apierrors.IsConflict(err):
		c.JSON(http.StatusConflict, gin.H{"error": fmt.Sprintf("concurrent edit on %s: %v", resource, err)})
	case apierrors.IsInvalid(err) || apierrors.IsBadRequest(err):
		c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("invalid request for %s: %v", resource, err)})
	default:
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("%s: %v", resource, err)})
	}
}

// RegisterRoutes mounts every API route on the Gin engine.
//
// Handler implementations are split by concern across files in this package:
// environment handlers in handlers_environment.go, loadtest handlers in
// handlers_loadtest.go, YAML import in yaml_import.go, YAML export in
// yaml_export.go, S3 config handlers in s3_configs.go, asset upload in assets.go.
func (h *Handler) RegisterRoutes(r *gin.Engine) {
	api := r.Group("/api")
	{
		api.GET("/environments", h.ListEnvironments)
		api.GET("/environments/:namespace/:name", h.GetEnvironment)
		api.GET("/environments/:namespace/:name/yaml", h.GetEnvironmentYAML)
		api.POST("/environments", h.CreateEnvironment)
		api.POST("/environments/yaml", h.CreateEnvironmentFromYAML)
		api.PATCH("/environments/:namespace/:name", h.UpdateEnvironment)
		api.DELETE("/environments/:namespace/:name", h.DeleteEnvironment)

		api.GET("/s3-configs", h.ListS3Configs)
		api.GET("/s3-configs/:name", h.GetS3Config)
		api.POST("/s3-configs", h.CreateS3Config)
		api.DELETE("/s3-configs/:name", h.DeleteS3Config)

		api.GET("/loadtests", h.ListLoadTests)
		api.GET("/loadtests/:namespace/:name", h.GetLoadTest)
		api.GET("/loadtests/:namespace/:name/yaml", h.GetLoadTestYAML)
		api.POST("/loadtests", h.CreateLoadTest)
		api.POST("/loadtests/assets", h.UploadLoadTestAsset)
		api.POST("/loadtests/yaml", h.CreateLoadTestFromYAML)
		api.POST("/loadtests/:namespace/:name/activate", h.ActivateLoadTest)
		api.PATCH("/loadtests/:namespace/:name/abort", h.AbortLoadTest)
		api.DELETE("/loadtests/:namespace/:name", h.DeleteLoadTest)
	}
}
