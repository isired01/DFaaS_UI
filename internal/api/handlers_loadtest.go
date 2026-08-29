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

func (h *Handler) ListLoadTests(c *gin.Context) {
	envFilter := c.Query("environment")

	ctx, cancel := context.WithTimeout(c.Request.Context(), 10*time.Second)
	defer cancel()

	result, err := h.client.Resource(LoadTestGVR).Namespace("").List(ctx, metav1.ListOptions{})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("list loadtests: %v", err)})
		return
	}

	var filterNs, filterName string
	if envFilter != "" {
		parts := strings.SplitN(envFilter, "/", 2)
		if len(parts) == 2 {
			filterNs, filterName = parts[0], parts[1]
		}
	}

	out := make([]LoadTestSummary, 0, len(result.Items))
	for _, item := range result.Items {
		s := mapLoadTestSummary(item)
		if filterNs != "" && (s.Namespace != filterNs || s.TargetEnvironment != filterName) {
			continue
		}
		out = append(out, s)
	}

	c.JSON(http.StatusOK, gin.H{"loadtests": out, "count": len(out)})
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

	if status, msg, ok := validatePerNodeLoad(req.PerNodeLoad); !ok {
		c.JSON(status, gin.H{"error": msg})
		return
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), 30*time.Second)
	defer cancel()

	envObj, err := h.client.Resource(EnvironmentGVR).Namespace(req.Namespace).Get(ctx, req.TargetEnvironment, metav1.GetOptions{})
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": fmt.Sprintf("environment '%s/%s' not found: %v", req.Namespace, req.TargetEnvironment, err)})
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
		ltName = sanitizeDNS1123(fmt.Sprintf("lt-%s-%s", req.TargetEnvironment, time.Now().Format("20060102-150405")))
		if req.NameSuffix != "" {
			ltName = sanitizeDNS1123(ltName + "-" + req.NameSuffix)
		}
	}

	// cleanup best-effort deletes the script ConfigMaps already created, used to
	// roll back when a later step in the sequence fails.
	createdCMs := make([]string, 0, len(req.PerNodeLoad))
	cleanup := func() {
		for _, cmName := range createdCMs {
			_ = h.client.Resource(ConfigMapGVR).Namespace(req.Namespace).Delete(context.Background(), cmName, metav1.DeleteOptions{})
		}
	}

	createdCMs, err = h.createScriptConfigMaps(ctx, ltName, &req)
	if err != nil {
		cleanup()
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	lt, status, msg, ok := buildLoadTestUnstructured(ltName, &req)
	if !ok {
		cleanup()
		c.JSON(status, gin.H{"error": msg})
		return
	}

	created, err := h.client.Resource(LoadTestGVR).Namespace(req.Namespace).Create(ctx, lt, metav1.CreateOptions{})
	if err != nil {
		cleanup()
		writeK8sError(c, err, fmt.Sprintf("loadtest '%s/%s'", req.Namespace, ltName))
		return
	}

	h.patchConfigMapOwnerRefs(ctx, req.Namespace, createdCMs, created)

	detail := mapLoadTestDetail(*created)
	h.inlineScripts(ctx, req.Namespace, &detail)

	c.JSON(http.StatusCreated, detail)
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
			return createdCMs, fmt.Errorf("create script configmap '%s': %v", cmName, err)
		}
		createdCMs = append(createdCMs, cmName)
		pn.ScriptConfigMap = cmName
	}
	return createdCMs, nil
}

// buildLoadTestUnstructured assembles the LoadTest object from the request,
// defaulting metricsExport.step to "15s" and validating that custom-promql
// metrics carry a metricName. On a metric validation failure it returns the
// HTTP status and message the handler should send; ok is false in that case.
func buildLoadTestUnstructured(ltName string, req *CreateLoadTestRequest) (lt *unstructured.Unstructured, status int, msg string, ok bool) {
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
	for i, m := range req.MetricsExport.Metrics {
		if m.Type == "custom-promql" && m.MetricName == "" {
			return nil, http.StatusBadRequest, fmt.Sprintf("metricsExport.metrics[%d]: metricName required when type='custom-promql'", i), false
		}
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

	lt = &unstructured.Unstructured{
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
	return lt, 0, "", true
}

// patchConfigMapOwnerRefs best-effort patches each script ConfigMap's
// ownerReferences to point at the freshly created LoadTest so the cluster GC
// reaps them when the LoadTest is deleted. Errors are ignored by design.
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
	patch, _ := json.Marshal(map[string]interface{}{
		"metadata": map[string]interface{}{
			"ownerReferences": []interface{}{ownerRef},
		},
	})
	for _, cmName := range cmNames {
		_, _ = h.client.Resource(ConfigMapGVR).Namespace(namespace).Patch(ctx, cmName, types.MergePatchType, patch, metav1.PatchOptions{})
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

// inlineScripts reads each referenced ConfigMap and inlines its "script.js" value.
func (h *Handler) inlineScripts(ctx context.Context, namespace string, detail *LoadTestDetail) {
	for i, pn := range detail.PerNodeLoad {
		if pn.ScriptConfigMap == "" {
			continue
		}
		cm, err := h.client.Resource(ConfigMapGVR).Namespace(namespace).Get(ctx, pn.ScriptConfigMap, metav1.GetOptions{})
		if err != nil {
			continue
		}
		detail.PerNodeLoad[i].Script = getNestedString(cm.Object, "data", "script.js")
	}
}

// ActivateLoadTest flips spec.suspended=false via merge-patch.
// 202 Accepted on success, 404 NotFound, 409 if already past Pending,
// 400 if Pending but not actually a draft (Conditions[Suspended] != True).
func (h *Handler) ActivateLoadTest(c *gin.Context) {
	namespace := c.Param("namespace")
	name := c.Param("name")

	ctx, cancel := context.WithTimeout(c.Request.Context(), 10*time.Second)
	defer cancel()

	obj, err := h.client.Resource(LoadTestGVR).Namespace(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": fmt.Sprintf("loadtest '%s/%s' not found: %v", namespace, name, err)})
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

	patch := []byte(`{"spec":{"suspended":false}}`)
	if _, err := h.client.Resource(LoadTestGVR).Namespace(namespace).Patch(ctx, name, types.MergePatchType, patch, metav1.PatchOptions{}); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("patch loadtest: %v", err)})
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
