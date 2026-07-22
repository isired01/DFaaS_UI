package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/types"
)

func (h *Handler) ListEnvironments(c *gin.Context) {
	ctx, cancel := context.WithTimeout(c.Request.Context(), 10*time.Second)
	defer cancel()

	result, err := h.client.Resource(EnvironmentGVR).Namespace("").List(ctx, metav1.ListOptions{})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("list environments: %v", err)})
		return
	}

	out := make([]EnvironmentSummary, 0, len(result.Items))
	for _, item := range result.Items {
		out = append(out, mapEnvSummary(item))
	}

	c.JSON(http.StatusOK, gin.H{"environments": out, "count": len(out)})
}

func (h *Handler) GetEnvironment(c *gin.Context) {
	namespace := c.Param("namespace")
	name := c.Param("name")

	ctx, cancel := context.WithTimeout(c.Request.Context(), 10*time.Second)
	defer cancel()

	result, err := h.client.Resource(EnvironmentGVR).Namespace(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		writeK8sError(c, err, fmt.Sprintf("environment '%s/%s'", namespace, name))
		return
	}

	c.JSON(http.StatusOK, mapEnvDetail(*result))
}

func (h *Handler) CreateEnvironment(c *gin.Context) {
	var req CreateEnvironmentRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("invalid body: %v", err)})
		return
	}

	if err := validateEnvNodes(req.Nodes); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	obj := buildEnvironmentUnstructured(req)

	ctx, cancel := context.WithTimeout(c.Request.Context(), 15*time.Second)
	defer cancel()

	created, err := h.client.Resource(EnvironmentGVR).Namespace(req.Namespace).Create(ctx, obj, metav1.CreateOptions{})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("create environment: %v", err)})
		return
	}

	c.JSON(http.StatusCreated, mapEnvDetail(*created))
}

// UpdateEnvironment applies a merge-patch to Environment.spec.
// 202 on success, 400/404/409/500 otherwise.
// Server forwards the user-supplied {"spec":{...}} payload verbatim as
// application/merge-patch+json. nodeID immutability for existing nodes is
// enforced UI-side (form renders nodeID readOnly on existing nodes); the gateway
// validates the node array shape (enum/required-fields/duplicates) only.
func (h *Handler) UpdateEnvironment(c *gin.Context) {
	namespace := c.Param("namespace")
	name := c.Param("name")

	var req UpdateEnvironmentRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("invalid body: %v", err)})
		return
	}

	if req.Spec.Nodes != nil {
		if err := validateEnvNodes(req.Spec.Nodes); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
	}

	// Build the merge patch as a map so an explicit s3ConfigRef clear survives
	// re-marshalling: ClearS3ConfigRef sets s3ConfigRef to JSON null (which the
	// merge-patch deletes on the cluster object), whereas the omitempty struct
	// field would silently drop the null. Other fields mirror the DTO's
	// pointer/omitempty semantics.
	specPatch := map[string]interface{}{}
	if req.Spec.CleanupOnDelete != nil {
		specPatch["cleanupOnDelete"] = *req.Spec.CleanupOnDelete
	}
	if len(req.Spec.Nodes) > 0 {
		specPatch["nodes"] = req.Spec.Nodes
	}
	if req.Spec.Topology != nil {
		specPatch["topology"] = req.Spec.Topology
	}
	if req.Spec.ClearS3ConfigRef {
		specPatch["s3ConfigRef"] = nil
	} else if req.Spec.S3ConfigRef != nil {
		specPatch["s3ConfigRef"] = req.Spec.S3ConfigRef
	}

	patchBytes, err := json.Marshal(map[string]interface{}{"spec": specPatch})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("marshal patch: %v", err)})
		return
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), 15*time.Second)
	defer cancel()

	patched, err := h.client.Resource(EnvironmentGVR).Namespace(namespace).Patch(ctx, name, types.MergePatchType, patchBytes, metav1.PatchOptions{})
	if err != nil {
		writeK8sError(c, err, fmt.Sprintf("environment '%s/%s'", namespace, name))
		return
	}

	observedGen, _, _ := unstructured.NestedInt64(patched.Object, "status", "observedGeneration")
	c.JSON(http.StatusAccepted, gin.H{
		"name":               patched.GetName(),
		"namespace":          patched.GetNamespace(),
		"generation":         patched.GetGeneration(),
		"observedGeneration": observedGen,
	})
}

// validateEnvNodes runs the same per-node shape checks Create uses,
// shared with the PATCH path.
func validateEnvNodes(nodes []NodeInfo) error {
	seen := map[string]struct{}{}
	for i, n := range nodes {
		if n.NodeID == "" || n.IpAddress == "" || n.Role == "" || n.Capacity == "" {
			return fmt.Errorf("node[%d]: nodeID, ipAddress, role, capacity required", i)
		}
		if _, dup := seen[n.NodeID]; dup {
			return fmt.Errorf("node[%d]: duplicate nodeID '%s'", i, n.NodeID)
		}
		seen[n.NodeID] = struct{}{}
		if n.Role != "dfaas-worker" && n.Role != "k6-load-generator" {
			return fmt.Errorf("node[%d]: role must be dfaas-worker or k6-load-generator", i)
		}
		switch n.Capacity {
		case "LOW", "MEDIUM", "HIGH":
		default:
			return fmt.Errorf("node[%d]: capacity must be LOW|MEDIUM|HIGH", i)
		}
		if n.Role == "k6-load-generator" {
			if n.BalancingStrategy != "" {
				return fmt.Errorf("node[%d]: balancingStrategy must be empty for k6-load-generator", i)
			}
			if len(n.Functions) > 0 {
				return fmt.Errorf("node[%d]: functions not allowed on k6-load-generator", i)
			}
		}
		if n.Role == "dfaas-worker" && n.BalancingStrategy != "" {
			switch n.BalancingStrategy {
			case "staticstrategy", "nodemarginstrategy", "recalcstrategy", "alllocalstrategy", "rlagentstrategy":
			default:
				return fmt.Errorf("node[%d]: balancingStrategy must be one of staticstrategy|nodemarginstrategy|recalcstrategy|alllocalstrategy|rlagentstrategy", i)
			}
		}
	}
	return nil
}

func (h *Handler) DeleteEnvironment(c *gin.Context) {
	namespace := c.Param("namespace")
	name := c.Param("name")

	ctx, cancel := context.WithTimeout(c.Request.Context(), 10*time.Second)
	defer cancel()

	err := h.client.Resource(EnvironmentGVR).Namespace(namespace).Delete(ctx, name, metav1.DeleteOptions{})
	if err != nil {
		writeK8sError(c, err, fmt.Sprintf("environment '%s/%s'", namespace, name))
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": fmt.Sprintf("environment '%s/%s' deletion requested", namespace, name)})
}

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
					"name":  f.Name,
					"image": f.Image,
				}
				// Emit the tuning fields only when set (>0): a blank form field
				// arrives as 0, and sending an explicit 0 would defeat the CRD's
				// defaulting (defaults apply to absent fields only) and deploy a
				// function with a 0 timeout. Omitting lets the CRD default apply.
				if f.ExecTimeout > 0 {
					fn["execTimeout"] = int64(f.ExecTimeout)
				}
				if f.MaxInflight > 0 {
					fn["maxInflight"] = int64(f.MaxInflight)
				}
				if f.TimeoutMs > 0 {
					fn["timeoutMs"] = int64(f.TimeoutMs)
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
