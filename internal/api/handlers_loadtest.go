package api

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/types"
)

func (h *Handler) ListLoadTests(c *gin.Context) {
	envFilter := c.Query("environment")

	// A malformed filter used to fall through to the full unfiltered list, which
	// reads as "this environment has every test in the cluster". Reject it.
	var filterNs, filterName string
	if envFilter != "" {
		parts := strings.SplitN(envFilter, "/", 2)
		if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("invalid environment filter '%s': expected 'namespace/name'", envFilter)})
			return
		}
		filterNs, filterName = parts[0], parts[1]
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), 10*time.Second)
	defer cancel()

	result, err := h.client.Resource(LoadTestGVR).Namespace("").List(ctx, metav1.ListOptions{})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("list loadtests: %v", err)})
		return
	}

	out := make([]LoadTestSummary, 0, len(result.Items))
	for _, item := range result.Items {
		s := mapLoadTestSummary(item)
		if filterNs != "" && (s.Namespace != filterNs || s.TargetEnvironment != filterName) {
			continue
		}
		out = append(out, s)
	}

	c.JSON(http.StatusOK, out)
}

func (h *Handler) GetLoadTest(c *gin.Context) {
	namespace := c.Param("namespace")
	name := c.Param("name")

	ctx, cancel := context.WithTimeout(c.Request.Context(), 10*time.Second)
	defer cancel()

	result, err := h.client.Resource(LoadTestGVR).Namespace(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		writeK8sError(c, err, fmt.Sprintf("loadtest '%s/%s'", namespace, name))
		return
	}

	detail := mapLoadTestDetail(*result)
	h.inlineScripts(ctx, namespace, &detail)

	// Completed tests get browsable SeaweedFS links to their artifacts.
	if detail.Phase == "Completed" && detail.TargetEnvironment != "" {
		detail.Results = h.resolveResultsURLs(ctx, namespace, detail.TargetEnvironment, detail.Name)
	}

	c.JSON(http.StatusOK, detail)
}

// CreateLoadTest is the only write path that materializes child resources.
// It validates the request, ensures the target Environment is Ready (unless the
// test is a draft/scheduled), materializes one script ConfigMap per inline
// script, creates the LoadTest, then best-effort patches ownerReferences so the
// cluster GC reaps the ConfigMaps when the LoadTest is deleted. Any failure
// after ConfigMaps are created rolls them back.
func (h *Handler) CreateLoadTest(c *gin.Context) {
	var req CreateLoadTestRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("invalid body: %v", err)})
		return
	}

	if req.StartAt != nil && !req.Suspended {
		c.JSON(http.StatusBadRequest, gin.H{"error": "startAt requires suspended=true"})
		return
	}

	// Every pure input-shape check runs before the first cluster write, so an
	// invalid submission never creates ConfigMaps only to roll them back.
	if status, msg, ok := validatePerNodeLoad(req.PerNodeLoad); !ok {
		c.JSON(status, gin.H{"error": msg})
		return
	}

	if status, msg, ok := validateMetricsExport(req.MetricsExport); !ok {
		c.JSON(status, gin.H{"error": msg})
		return
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), 30*time.Second)
	defer cancel()

	envObj, err := h.client.Resource(EnvironmentGVR).Namespace(req.Namespace).Get(ctx, req.TargetEnvironment, metav1.GetOptions{})
	if err != nil {
		writeK8sError(c, err, fmt.Sprintf("environment '%s/%s'", req.Namespace, req.TargetEnvironment))
		return
	}

	// The operator dispatches against Ready or Degraded environments, so gate on
	// both. Draft/scheduled tests skip the gate (they run later once the env settles).
	phase := getNestedString(envObj.Object, "status", "phase")
	if !req.Suspended && req.StartAt == nil && phase != "Ready" && phase != "Degraded" {
		c.JSON(http.StatusConflict, gin.H{"error": fmt.Sprintf("environment '%s' is not dispatchable (current phase: %s; requires Ready or Degraded)", req.TargetEnvironment, phase)})
		return
	}

	k6IDs := buildK6NodeIndex(envObj)
	for i, pn := range req.PerNodeLoad {
		if _, ok := k6IDs[pn.NodeID]; !ok {
			valid := make([]string, 0, len(k6IDs))
			for id := range k6IDs {
				valid = append(valid, id)
			}
			c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("perNodeLoad[%d].nodeID '%s' not a k6-load-generator (valid: %v)", i, pn.NodeID, valid)})
			return
		}
	}

	ltName := req.Name
	if ltName == "" {
		generated := fmt.Sprintf("lt-%s-%s", req.TargetEnvironment, time.Now().Format("20060102-150405"))
		if req.NameSuffix != "" {
			generated += "-" + req.NameSuffix
		}
		// The timestamp is second-granular and the name also seeds every script
		// ConfigMap name, so a double-click on Create (or a client retry) inside
		// the same second would collide. Mix in a short nonce, same idea as
		// bucketNameFor's UID suffix.
		ltName = sanitizeDNS1123(generated + "-" + shortNonce())
	}

	// cleanup best-effort deletes the script ConfigMaps already created, used to
	// roll back when a later step in the sequence fails. Failures are logged and
	// otherwise ignored — an orphaned ConfigMap must not mask the real error.
	createdCMs := make([]string, 0, len(req.PerNodeLoad))
	cleanup := func() {
		for _, cmName := range createdCMs {
			if derr := h.client.Resource(ConfigMapGVR).Namespace(req.Namespace).Delete(context.Background(), cmName, metav1.DeleteOptions{}); derr != nil && !apierrors.IsNotFound(derr) {
				log.Printf("loadtest '%s/%s': rollback of script configmap '%s' failed, it is now orphaned: %v", req.Namespace, ltName, cmName, derr)
			}
		}
	}

	createdCMs, err = h.createScriptConfigMaps(ctx, ltName, &req)
	if err != nil {
		cleanup()
		// A name collision is the caller's problem (409), anything else is ours.
		// The error already names the offending ConfigMap, so it is echoed as-is
		// rather than routed through writeK8sError.
		status := http.StatusInternalServerError
		if apierrors.IsAlreadyExists(err) {
			status = http.StatusConflict
		}
		c.JSON(status, gin.H{"error": err.Error()})
		return
	}

	created, err := h.client.Resource(LoadTestGVR).Namespace(req.Namespace).Create(ctx, buildLoadTestUnstructured(ltName, &req), metav1.CreateOptions{})
	if err != nil {
		cleanup()
		writeK8sError(c, err, fmt.Sprintf("loadtest '%s/%s'", req.Namespace, ltName))
		return
	}

	h.patchConfigMapOwnerRefs(ctx, req.Namespace, createdCMs, created)

	detail := mapLoadTestDetail(*created)
	// Echo back the scripts the caller just submitted instead of re-reading the
	// ConfigMaps written a moment ago: the round-trip buys nothing and a blip
	// would blank the script in a 201, which reads as data loss. inlineScripts
	// then only fetches entries that referenced a pre-existing ConfigMap.
	submitted := make(map[string]string, len(req.PerNodeLoad))
	for _, pn := range req.PerNodeLoad {
		if pn.Script != "" {
			submitted[pn.NodeID] = pn.Script
		}
	}
	for i := range detail.PerNodeLoad {
		detail.PerNodeLoad[i].Script = submitted[detail.PerNodeLoad[i].NodeID]
	}
	h.inlineScripts(ctx, req.Namespace, &detail)

	c.JSON(http.StatusCreated, detail)
}

// shortNonce returns a short lowercase-hex disambiguator for generated resource
// names.
func shortNonce() string {
	return uuid.NewString()[:6]
}

// validatePerNodeLoad enforces that each entry carries exactly one of an inline
// script or a ConfigMap reference. On failure it returns the HTTP status and
// message the handler should send; ok is false in that case.
func validatePerNodeLoad(perNodeLoad []CreatePerNodeLoad) (status int, msg string, ok bool) {
	for i, pn := range perNodeLoad {
		if pn.Script == "" && pn.ScriptConfigMap == "" {
			return http.StatusBadRequest, fmt.Sprintf("perNodeLoad[%d]: script or scriptConfigMap required", i), false
		}
		if pn.Script != "" && pn.ScriptConfigMap != "" {
			return http.StatusBadRequest, fmt.Sprintf("perNodeLoad[%d]: only one of script or scriptConfigMap allowed", i), false
		}
		if err := validateGoDuration(fmt.Sprintf("perNodeLoad[%d].duration", i), pn.Duration); err != nil {
			return http.StatusBadRequest, err.Error(), false
		}
	}
	return 0, "", true
}

// validateMetricsExport enforces that custom-promql metrics carry a metricName.
// Pure input-shape check, so the handler runs it before touching the cluster.
// On failure it returns the HTTP status and message the handler should send; ok
// is false in that case.
func validateMetricsExport(export CreateMetricsExport) (status int, msg string, ok bool) {
	for i, m := range export.Metrics {
		if !hasEnum(rules.LoadTest.MetricTypes, m.Type) {
			return http.StatusBadRequest, fmt.Sprintf("metricsExport.metrics[%d]: type must be %s", i, enumValues(rules.LoadTest.MetricTypes)), false
		}
		if m.Type == metricPromQL && m.MetricName == "" {
			return http.StatusBadRequest, fmt.Sprintf("metricsExport.metrics[%d]: metricName required when type='custom-promql'", i), false
		}
	}
	return 0, "", true
}

// buildK6NodeIndex returns the set of valid k6 nodeIDs for the environment,
// taken from status.k6Nodes[] and falling back to spec.nodes[] entries with
// role == "k6-load-generator" when status is still empty.
func buildK6NodeIndex(env *unstructured.Unstructured) map[string]struct{} {
	k6IDs := map[string]struct{}{}
	k6Status, _, _ := unstructured.NestedSlice(env.Object, "status", "k6Nodes")
	for _, raw := range k6Status {
		if k6Node, ok := raw.(map[string]interface{}); ok {
			if id := getStringFromMap(k6Node, "nodeID"); id != "" {
				k6IDs[id] = struct{}{}
			}
		}
	}
	if len(k6IDs) == 0 {
		nodes, _, _ := unstructured.NestedSlice(env.Object, "spec", "nodes")
		for _, raw := range nodes {
			if node, ok := raw.(map[string]interface{}); ok {
				if getStringFromMap(node, "role") == "k6-load-generator" {
					if id := getStringFromMap(node, "nodeID"); id != "" {
						k6IDs[id] = struct{}{}
					}
				}
			}
		}
	}
	return k6IDs
}

// createScriptConfigMaps materializes one ConfigMap per perNodeLoad entry that
// carries an inline script, naming each "<ltName>-<nodeID>-script" with the body
// under data["script.js"]. It mutates each entry's ScriptConfigMap to point at
// the created ConfigMap and returns the names created so the caller can roll
// them back on a later failure.
func (h *Handler) createScriptConfigMaps(ctx context.Context, ltName string, req *CreateLoadTestRequest) ([]string, error) {
	createdCMs := make([]string, 0, len(req.PerNodeLoad))
	for i := range req.PerNodeLoad {
		pn := &req.PerNodeLoad[i]
		if pn.Script == "" {
			continue
		}
		cmName := sanitizeDNS1123(fmt.Sprintf("%s-%s-script", ltName, pn.NodeID))
		cm := &unstructured.Unstructured{
			Object: map[string]interface{}{
				"apiVersion": "v1",
				"kind":       "ConfigMap",
				"metadata": map[string]interface{}{
					"name":      cmName,
					"namespace": req.Namespace,
					"labels": map[string]interface{}{
						"dfaas.io/loadtest":    ltName,
						"dfaas.io/environment": req.TargetEnvironment,
						"dfaas.io/node-id":     pn.NodeID,
					},
				},
				"data": map[string]interface{}{
					"script.js": pn.Script,
				},
			},
		}
		if _, err := h.client.Resource(ConfigMapGVR).Namespace(req.Namespace).Create(ctx, cm, metav1.CreateOptions{}); err != nil {
			// %w keeps the k8s status reason intact so writeK8sError can map an
			// AlreadyExists collision to 409 instead of a blanket 500.
			return createdCMs, fmt.Errorf("create script configmap '%s': %w", cmName, err)
		}
		createdCMs = append(createdCMs, cmName)
		pn.ScriptConfigMap = cmName
	}
	return createdCMs, nil
}

// buildLoadTestUnstructured assembles the LoadTest object from the request,
// defaulting metricsExport.step to "15s". The request is assumed already
// validated (validatePerNodeLoad + validateMetricsExport run in the handler,
// before any child resource is created).
func buildLoadTestUnstructured(ltName string, req *CreateLoadTestRequest) *unstructured.Unstructured {
	step := req.MetricsExport.Step
	if step == "" {
		step = "15s"
	}

	perNodeSpec := make([]interface{}, 0, len(req.PerNodeLoad))
	for _, pn := range req.PerNodeLoad {
		perNodeSpec = append(perNodeSpec, map[string]interface{}{
			"nodeID":   pn.NodeID,
			"vus":      int64(pn.VUs),
			"duration": pn.Duration,
			"scriptConfigMap": map[string]interface{}{
				"name": pn.ScriptConfigMap,
			},
		})
	}

	metrics := make([]interface{}, 0, len(req.MetricsExport.Metrics))
	for _, m := range req.MetricsExport.Metrics {
		entry := map[string]interface{}{
			"type":  m.Type,
			"query": m.Query,
		}
		if m.MetricName != "" {
			entry["metricName"] = m.MetricName
		}
		if m.Comment != "" {
			entry["comment"] = m.Comment
		}
		metrics = append(metrics, entry)
	}

	metricsExport := map[string]interface{}{
		"metrics": metrics,
		"step":    step,
	}

	spec := map[string]interface{}{
		"targetEnvironment": req.TargetEnvironment,
		"perNodeLoad":       perNodeSpec,
		"metricsExport":     metricsExport,
	}
	if req.Suspended {
		spec["suspended"] = true
	}
	if req.SyncStart {
		spec["syncStart"] = true
	}
	if req.StartAt != nil {
		spec["startAt"] = req.StartAt.UTC().Format(time.RFC3339)
	}

	return &unstructured.Unstructured{
		Object: map[string]interface{}{
			"apiVersion": "dfaas.dfaas.io/v1",
			"kind":       "LoadTest",
			"metadata": map[string]interface{}{
				"name":      ltName,
				"namespace": req.Namespace,
			},
			"spec": spec,
		},
	}
}

// patchConfigMapOwnerRefs best-effort patches each script ConfigMap's
// ownerReferences to point at the freshly created LoadTest so the cluster GC
// reaps them when the LoadTest is deleted. A failure never fails the request —
// the LoadTest itself is already created and usable — but it is logged, since
// an un-owned ConfigMap survives the LoadTest forever with no other signal.
func (h *Handler) patchConfigMapOwnerRefs(ctx context.Context, namespace string, cmNames []string, owner *unstructured.Unstructured) {
	if len(cmNames) == 0 {
		return
	}
	ownerRef := map[string]interface{}{
		"apiVersion":         "dfaas.dfaas.io/v1",
		"kind":               "LoadTest",
		"name":               owner.GetName(),
		"uid":                string(owner.GetUID()),
		"controller":         true,
		"blockOwnerDeletion": true,
	}
	patch, err := json.Marshal(map[string]interface{}{
		"metadata": map[string]interface{}{
			"ownerReferences": []interface{}{ownerRef},
		},
	})
	if err != nil {
		log.Printf("loadtest '%s/%s': marshal ownerReferences patch: %v", namespace, owner.GetName(), err)
		return
	}
	for _, cmName := range cmNames {
		if _, perr := h.client.Resource(ConfigMapGVR).Namespace(namespace).Patch(ctx, cmName, types.MergePatchType, patch, metav1.PatchOptions{}); perr != nil {
			log.Printf("loadtest '%s/%s': setting ownerReferences on script configmap '%s' failed, it will not be garbage-collected with the loadtest: %v", namespace, owner.GetName(), cmName, perr)
		}
	}
}

func (h *Handler) DeleteLoadTest(c *gin.Context) {
	namespace := c.Param("namespace")
	name := c.Param("name")

	ctx, cancel := context.WithTimeout(c.Request.Context(), 10*time.Second)
	defer cancel()

	if err := h.client.Resource(LoadTestGVR).Namespace(namespace).Delete(ctx, name, metav1.DeleteOptions{}); err != nil {
		writeK8sError(c, err, fmt.Sprintf("loadtest '%s/%s'", namespace, name))
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": fmt.Sprintf("loadtest '%s/%s' deletion requested", namespace, name)})
}

// inlineScripts reads each referenced ConfigMap and inlines its "script.js"
// value. Entries whose Script is already populated (the create path echoes back
// what the caller submitted) are left alone. A ConfigMap that cannot be read is
// logged rather than silently blanked: GetLoadTest is polled for a test's whole
// lifetime, so a blank script in an otherwise 200 response reads as data loss.
func (h *Handler) inlineScripts(ctx context.Context, namespace string, detail *LoadTestDetail) {
	for i, pn := range detail.PerNodeLoad {
		if pn.ScriptConfigMap == "" || pn.Script != "" {
			continue
		}
		cm, err := h.client.Resource(ConfigMapGVR).Namespace(namespace).Get(ctx, pn.ScriptConfigMap, metav1.GetOptions{})
		if err != nil {
			log.Printf("loadtest '%s/%s': inlining script for node '%s' from configmap '%s' failed, the script is reported empty: %v", namespace, detail.Name, pn.NodeID, pn.ScriptConfigMap, err)
			continue
		}
		detail.PerNodeLoad[i].Script = getNestedString(cm.Object, "data", "script.js")
	}
}

// ActivateLoadTest flips spec.suspended=false via merge-patch.
// 202 Accepted on success, 404 NotFound, 409 if already past Pending or if the
// object moved between the read and the patch, 400 if Pending but not actually
// a draft (spec.suspended != true).
func (h *Handler) ActivateLoadTest(c *gin.Context) {
	namespace := c.Param("namespace")
	name := c.Param("name")

	ctx, cancel := context.WithTimeout(c.Request.Context(), 10*time.Second)
	defer cancel()

	obj, err := h.client.Resource(LoadTestGVR).Namespace(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		writeK8sError(c, err, fmt.Sprintf("loadtest '%s/%s'", namespace, name))
		return
	}

	phase := getNestedString(obj.Object, "status", "phase")
	if phase != "" && phase != "Pending" {
		c.JSON(http.StatusConflict, gin.H{"error": fmt.Sprintf("loadtest '%s' phase is '%s' — activation only valid while Pending", name, phase)})
		return
	}

	// Check desired state, not observed condition: avoids race when reconciler
	// hasn't stamped Conditions[Suspended] yet on a freshly-created draft.
	suspended, _, _ := unstructured.NestedBool(obj.Object, "spec", "suspended")
	if !suspended {
		c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("loadtest '%s' is not a draft (spec.suspended != true)", name)})
		return
	}

	// Carry the observed resourceVersion in the patch so the API server rejects
	// it with a conflict if the object moved between the Get above and this
	// write — a stale Activate must not un-suspend a test that has since been
	// aborted, rescheduled or re-suspended.
	patch, err := json.Marshal(map[string]interface{}{
		"metadata": map[string]interface{}{"resourceVersion": obj.GetResourceVersion()},
		"spec":     map[string]interface{}{"suspended": false},
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("marshal patch: %v", err)})
		return
	}
	if _, err := h.client.Resource(LoadTestGVR).Namespace(namespace).Patch(ctx, name, types.MergePatchType, patch, metav1.PatchOptions{}); err != nil {
		writeK8sError(c, err, fmt.Sprintf("loadtest '%s/%s'", namespace, name))
		return
	}

	c.Status(http.StatusAccepted)
}

// AbortLoadTest flips spec.stop=true via merge-patch. Thin pass-through:
// operator owns the run-once guard (silent no-op on Exporting/Completed/
// Failed/Aborted) and the phase transition. Gateway forwards the patch
// regardless of phase; UI hides the button outside {Pending, Running}.
// 202 Accepted on success, 404 NotFound, 409 on resourceVersion conflict,
// 500 otherwise.
func (h *Handler) AbortLoadTest(c *gin.Context) {
	namespace := c.Param("namespace")
	name := c.Param("name")

	ctx, cancel := context.WithTimeout(c.Request.Context(), 10*time.Second)
	defer cancel()

	patch := []byte(`{"spec":{"stop":true}}`)
	if _, err := h.client.Resource(LoadTestGVR).Namespace(namespace).Patch(ctx, name, types.MergePatchType, patch, metav1.PatchOptions{}); err != nil {
		writeK8sError(c, err, fmt.Sprintf("loadtest '%s/%s'", namespace, name))
		return
	}

	c.JSON(http.StatusAccepted, gin.H{
		"name":      name,
		"namespace": namespace,
		"stop":      true,
	})
}
