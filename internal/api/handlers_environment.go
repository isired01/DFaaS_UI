package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
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

	c.JSON(http.StatusOK, out)
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
		writeK8sError(c, err, fmt.Sprintf("environment '%s/%s'", req.Namespace, req.Name))
		return
	}

	c.JSON(http.StatusCreated, mapEnvDetail(*created))
}

// UpdateEnvironment applies a merge-patch to Environment.spec.
// 202 on success, 400/404/409/500 otherwise.
// Server forwards the user-supplied {"spec":{...}} payload verbatim as
// application/merge-patch+json. nodeID immutability for existing nodes is
// enforced UI-side (form renders nodeID readOnly on existing nodes); the gateway
// validates the node array shape (enum/required-fields/duplicates/role
// composition) and refuses node or topology edits while a load test on this
// environment is still active — see the comment on that check below.
func (h *Handler) UpdateEnvironment(c *gin.Context) {
	namespace := c.Param("namespace")
	name := c.Param("name")

	var req UpdateEnvironmentRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("invalid body: %v", err)})
		return
	}

	if req.Spec.Nodes != nil {
		// An explicit empty array is not a valid clear (the CRD requires at least
		// one node), and silently dropping it would look like a successful edit.
		if len(req.Spec.Nodes) == 0 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "spec.nodes cannot be empty; omit the field to leave the node list unchanged"})
			return
		}
		if err := validateEnvNodes(req.Spec.Nodes); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
	}

	// Editing spec.nodes or spec.topology bumps metadata.generation, and
	// handleGenerationDrift then restarts the provisioning FSM from
	// ProvisioningVMs and re-runs Ansible against every node — regardless of
	// what actually changed. Since a role change now wipes the node's k3s
	// outright (the repave block in the playbooks), doing that under a live
	// experiment destroys it. Neither the CRD nor the operator guards this, so
	// the gateway is the gate. s3ConfigRef-only patches are unaffected.
	if req.Spec.Nodes != nil || req.Spec.Topology != nil {
		ltCtx, ltCancel := context.WithTimeout(c.Request.Context(), 10*time.Second)
		defer ltCancel()

		lts, err := h.client.Resource(LoadTestGVR).Namespace(namespace).List(ltCtx, metav1.ListOptions{})
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("list loadtests: %v", err)})
			return
		}
		if active := activeLoadTestNames(lts.Items, namespace, name); len(active) > 0 {
			c.JSON(http.StatusConflict, gin.H{"error": fmt.Sprintf(
				"environment has active load tests: %s; abort them or wait for completion before editing nodes or topology",
				strings.Join(active, ", "))})
			return
		}
	}

	// Build the merge patch as a map so an explicit s3ConfigRef clear survives
	// re-marshalling: ClearS3ConfigRef sets s3ConfigRef to JSON null (which the
	// merge-patch deletes on the cluster object), whereas the omitempty struct
	// field would silently drop the null. Other fields mirror the DTO's
	// pointer/omitempty semantics.
	specPatch := map[string]interface{}{}
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

// activeLoadTestNames returns "<name> (<phase>)" for every LoadTest in items
// that targets namespace/envName and still owns its k6 nodes.
//
// Running and Exporting are self-evident. Pending counts too, because dispatch
// is imminent and a repave mid-dispatch is just as destructive — except when
// the test is suspended, which means it is parked waiting for /activate and
// owns nothing; blocking edits on those would block them indefinitely.
func activeLoadTestNames(items []unstructured.Unstructured, namespace, envName string) []string {
	var active []string
	for _, item := range items {
		s := mapLoadTestSummary(item)
		if s.Namespace != namespace || s.TargetEnvironment != envName {
			continue
		}
		switch s.Phase {
		case "Running", "Exporting":
		case "Pending":
			if s.Suspended {
				continue
			}
		default:
			continue
		}
		active = append(active, fmt.Sprintf("%s (%s)", s.Name, s.Phase))
	}
	return active
}

// validateEnvNodes runs the same per-node shape checks Create uses,
// shared with the PATCH path.
func validateEnvNodes(nodes []NodeInfo) error {
	seen := map[string]struct{}{}
	var workers, generators int
	for i, n := range nodes {
		if n.NodeID == "" || n.IpAddress == "" || n.Role == "" || n.Capacity == "" {
			return fmt.Errorf("node[%d]: nodeID, ipAddress, role, capacity required", i)
		}
		if _, dup := seen[n.NodeID]; dup {
			return fmt.Errorf("node[%d]: duplicate nodeID '%s'", i, n.NodeID)
		}
		seen[n.NodeID] = struct{}{}
		switch n.Role {
		case "dfaas-worker":
			workers++
		case "k6-load-generator":
			generators++
		default:
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

	// Role composition. Nothing downstream rejects a single-role Environment:
	// ensureAnsibleJob skips a role with zero nodes and reports its condition
	// True, so the Environment reaches Ready and only fails obscurely once a
	// LoadTest is dispatched at it. Editing roles on an existing Environment
	// makes this easy to hit by accident, so it is caught here — on create,
	// patch and YAML import alike, since all three share this validator.
	if workers == 0 {
		return fmt.Errorf("at least one node must have role dfaas-worker: an environment with no workers has nothing to load-test")
	}
	if generators == 0 {
		return fmt.Errorf("at least one node must have role k6-load-generator: an environment with no generators cannot run a load test")
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
		"nodes": nodes,
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
