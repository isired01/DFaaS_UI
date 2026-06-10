package api

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	yamlv3 "gopkg.in/yaml.v3"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

// buildEnvironmentUnstructured assembles the Environment object from the typed
// create request, omitting optional fields (balancingStrategy, functions,
// topology, s3ConfigRef) when empty.
func buildEnvironmentUnstructured(req CreateEnvironmentRequest) *unstructured.Unstructured {
	nodes := make([]interface{}, 0, len(req.Nodes))
	for _, n := range req.Nodes {
		node := map[string]interface{}{
			"nodeID":    n.NodeID,
			"ipAddress": n.IpAddress,
			"role":      n.Role,
			"capacity":  n.Capacity,
			"username":  n.Username,
			"password":  n.Password,
		}
		if n.BalancingStrategy != "" {
			node["balancingStrategy"] = n.BalancingStrategy
		}
		if len(n.Functions) > 0 {
			funcs := make([]interface{}, 0, len(n.Functions))
			for _, f := range n.Functions {
				fn := map[string]interface{}{
					"name":        f.Name,
					"image":       f.Image,
					"execTimeout": int64(f.ExecTimeout),
					"maxInflight": int64(f.MaxInflight),
					"timeoutMs":   int64(f.TimeoutMs),
				}
				if f.MaxRate > 0 {
					fn["maxRate"] = int64(f.MaxRate)
				}
				funcs = append(funcs, fn)
			}
			node["functions"] = funcs
		}
		nodes = append(nodes, node)
	}

	links := make([]interface{}, 0, len(req.Topology.Links))
	for _, l := range req.Topology.Links {
		links = append(links, map[string]interface{}{
			"nodeA":     l.NodeA,
			"nodeB":     l.NodeB,
			"latencyMs": int64(l.LatencyMs),
		})
	}

	spec := map[string]interface{}{
		"nodes":           nodes,
		"cleanupOnDelete": req.CleanupOnDelete,
	}
	if len(links) > 0 {
		spec["topology"] = map[string]interface{}{"links": links}
	}
	if req.S3ConfigRef != nil && req.S3ConfigRef.Name != "" {
		spec["s3ConfigRef"] = map[string]interface{}{"name": req.S3ConfigRef.Name}
	}

	return &unstructured.Unstructured{
		Object: map[string]interface{}{
			"apiVersion": "dfaas.dfaas.io/v1",
			"kind":       "Environment",
			"metadata": map[string]interface{}{
				"name":      req.Name,
				"namespace": req.Namespace,
			},
			"spec": spec,
		},
	}
}

// --- YAML apply handlers ---

// CreateEnvironmentFromYAML accepts a raw CR YAML body and creates an
// Environment, mirroring `kubectl apply -f` UX.
func (h *Handler) CreateEnvironmentFromYAML(c *gin.Context) {
	h.applyResourceYAML(c, EnvironmentGVR, "Environment", "dfaas.dfaas.io/v1")
}

// CreateLoadTestFromYAML accepts a raw CR YAML body and creates a LoadTest,
// mirroring `kubectl apply -f` UX.
func (h *Handler) CreateLoadTestFromYAML(c *gin.Context) {
	h.applyResourceYAML(c, LoadTestGVR, "LoadTest", "dfaas.dfaas.io/v1")
}

// applyResourceYAML reads a YAML CR body, validates apiVersion+kind, scrubs
// server-managed fields, defaults namespace to "default", and creates the
// resource via the dynamic client. Bypasses the typed DTO entirely so a user
// can round-trip a downloaded YAML (possibly with an edited metadata.name).
func (h *Handler) applyResourceYAML(c *gin.Context, gvr schema.GroupVersionResource, expectedKind string, expectedAPIVersion string) {
	body, err := io.ReadAll(io.LimitReader(c.Request.Body, 1<<20))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("read body: %v", err)})
		return
	}
	if len(body) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "empty body"})
		return
	}

	var obj map[string]interface{}
	if err := yamlv3.Unmarshal(body, &obj); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("parse yaml: %v", err)})
		return
	}
	if obj == nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "yaml body did not decode to an object"})
		return
	}

	gotAPIVersion := getStringFromMap(obj, "apiVersion")
	gotKind := getStringFromMap(obj, "kind")
	if gotAPIVersion != expectedAPIVersion {
		c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("invalid apiVersion: expected %s got %s", expectedAPIVersion, gotAPIVersion)})
		return
	}
	if gotKind != expectedKind {
		c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("invalid kind: expected %s got %s", expectedKind, gotKind)})
		return
	}

	// Strip server-managed metadata + status so the create is accepted by the API server.
	cleanForApply(obj)

	md, _ := obj["metadata"].(map[string]interface{})
	if md == nil {
		md = map[string]interface{}{}
		obj["metadata"] = md
	}
	namespace := getStringFromMap(md, "namespace")
	if namespace == "" {
		namespace = "default"
		md["namespace"] = namespace
	}
	name := getStringFromMap(md, "name")
	if name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "metadata.name required"})
		return
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), 15*time.Second)
	defer cancel()

	u := &unstructured.Unstructured{Object: obj}
	created, err := h.client.Resource(gvr).Namespace(namespace).Create(ctx, u, metav1.CreateOptions{})
	if err != nil {
		switch {
		case apierrors.IsAlreadyExists(err):
			c.JSON(http.StatusConflict, gin.H{"error": fmt.Sprintf("%s '%s/%s' already exists", expectedKind, namespace, name)})
		case apierrors.IsInvalid(err) || apierrors.IsBadRequest(err):
			c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("invalid %s: %v", expectedKind, err)})
		case apierrors.IsNotFound(err):
			c.JSON(http.StatusNotFound, gin.H{"error": fmt.Sprintf("not found while creating %s: %v", expectedKind, err)})
		default:
			c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("create %s: %v", expectedKind, err)})
		}
		return
	}

	c.JSON(http.StatusCreated, gin.H{
		"namespace": created.GetNamespace(),
		"name":      created.GetName(),
		"kind":      expectedKind,
	})
}
