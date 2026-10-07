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
// composition) and refuses any spec edit while a load test on this
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

	// Every field this DTO carries bumps metadata.generation when it changes,
	// and handleGenerationDrift then restarts the provisioning FSM from
	// ProvisioningVMs and re-runs Ansible against every node — regardless of
	// what actually changed. A role change wipes the node's k3s outright (the
	// repave block in the playbooks), and even an s3ConfigRef-only edit ends a
	// dispatched test and redirects a running test's export. Neither the CRD
	// nor the operator guards this, so the gateway is the gate, on every PATCH.
	// It does not tell a no-op apart: an empty PATCH is also refused while a
	// test is active.
	ltCtx, ltCancel := context.WithTimeout(c.Request.Context(), 10*time.Second)
	defer ltCancel()

	lts, err := h.client.Resource(LoadTestGVR).Namespace(namespace).List(ltCtx, metav1.ListOptions{})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("list loadtests: %v", err)})
		return
	}
	if active := activeLoadTestNames(lts.Items, namespace, name); len(active) > 0 {
		c.JSON(http.StatusConflict, gin.H{"error": heldByMessage(active, "editing")})
		return
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

// heldByMessage is the 409 for an edit or a delete refused while load tests
// hold the Environment. The labels come from activeLoadTestNames, the same
// ones the SPA's lt.holdReason prints.
func heldByMessage(active []string, doing string) string {
	return fmt.Sprintf("environment is held by load tests: %s; abort or wait for the running ones, "+
		"delete the ones noted, before %s the Environment", strings.Join(active, ", "), doing)
}

// activeLoadTestNames returns "<name> (<phase>)" for every LoadTest in items
// that targets namespace/envName and still holds it, with the remedy appended
// for a test whose runners were not reclaimed. Gates both UpdateEnvironment
// and DeleteEnvironment. The SPA's lt.holdReason (ui/src/lib/crstate.js)
// prints the same labels: change both together.
//
// Running and Exporting are self-evident. Pending counts too, because dispatch
// is imminent and a repave mid-dispatch is just as destructive — except when
// the test is suspended, which means it is parked waiting for /activate and
// owns nothing; blocking edits on those would block them indefinitely.
//
// A terminal test counts while its runners are unreclaimed: a remote runner
// the run end could not delete may still be loading the nodes, and the
// operator's Occupancy holds the Environment on it too.
func activeLoadTestNames(items []unstructured.Unstructured, namespace, envName string) []string {
	var active []string
	for _, item := range items {
		s := mapLoadTestSummary(item)
		if s.Namespace != namespace || s.TargetEnvironment != envName {
			continue
		}
		switch s.Phase {
		case "Running", "Exporting":
		case "", "Pending":
			// "" is a test the operator has not admitted yet: about to dispatch.
			if s.Suspended {
				continue
			}
		default:
			if s.RunnersUnreclaimed {
				active = append(active, fmt.Sprintf(
					"%s (%s, runners not reclaimed: delete the test to release the Environment, up to 2 min)",
					s.Name, s.Phase))
			}
			continue
		}
		active = append(active, fmt.Sprintf("%s (%s)", s.Name, s.Phase))
	}
	return active
}

// DeleteEnvironment deletes an Environment: 200 on success or when a deletion
// is already in progress, 404 when it does not exist, 409 while a load test
// holds it (activeLoadTestNames). The operator's finalizer would abort that
// test and delete every LoadTest the Environment owns, finished ones included.
func (h *Handler) DeleteEnvironment(c *gin.Context) {
	namespace := c.Param("namespace")
	name := c.Param("name")

	ctx, cancel := context.WithTimeout(c.Request.Context(), 10*time.Second)
	defer cancel()

	envs := h.client.Resource(EnvironmentGVR).Namespace(namespace)
	env, err := envs.Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		writeK8sError(c, err, fmt.Sprintf("environment '%s/%s'", namespace, name))
		return
	}
	// A second click while the finalizer drains: the tests it is aborting
	// still count as holding the Environment.
	if env.GetDeletionTimestamp() != nil {
		c.JSON(http.StatusOK, gin.H{"message": fmt.Sprintf("environment '%s/%s' deletion already in progress", namespace, name)})
		return
	}

	lts, err := h.client.Resource(LoadTestGVR).Namespace(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("list loadtests: %v", err)})
		return
	}
	if active := activeLoadTestNames(lts.Items, namespace, name); len(active) > 0 {
		c.JSON(http.StatusConflict, gin.H{"error": heldByMessage(active, "deleting")})
		return
	}

	// Background, stated explicitly: the operator's finalizer drains the
	// Environment's LoadTests before it prunes the kubeconfig Secrets they
	// need, and foreground propagation would let GC delete those Secrets in
	// parallel. The UID precondition keeps a same-named Environment recreated
	// since the Get from being deleted.
	bg := metav1.DeletePropagationBackground
	uid := env.GetUID()
	if err := envs.Delete(ctx, name, metav1.DeleteOptions{
		PropagationPolicy: &bg,
		Preconditions:     &metav1.Preconditions{UID: &uid},
	}); err != nil {
		writeK8sError(c, err, fmt.Sprintf("environment '%s/%s'", namespace, name))
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": fmt.Sprintf("environment '%s/%s' deletion requested", namespace, name)})
}

// buildEnvironmentUnstructured assembles the Environment object from the typed
// create request, omitting optional fields (balancingStrategy, functions,
// s3ConfigRef) when empty.
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

	spec := map[string]interface{}{
		"nodes": nodes,
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
