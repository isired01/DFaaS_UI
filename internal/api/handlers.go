package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	yamlv3 "gopkg.in/yaml.v3"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
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

// RegisterRoutes mounts every API route on the Gin engine.
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

		api.GET("/loadtests", h.ListLoadTests)
		api.GET("/loadtests/:namespace/:name", h.GetLoadTest)
		api.GET("/loadtests/:namespace/:name/yaml", h.GetLoadTestYAML)
		api.POST("/loadtests", h.CreateLoadTest)
		api.POST("/loadtests/yaml", h.CreateLoadTestFromYAML)
		api.POST("/loadtests/:namespace/:name/activate", h.ActivateLoadTest)
		api.PATCH("/loadtests/:namespace/:name/abort", h.AbortLoadTest)
		api.DELETE("/loadtests/:namespace/:name", h.DeleteLoadTest)
	}
}

// --- Environment handlers ---

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
		c.JSON(http.StatusNotFound, gin.H{"error": fmt.Sprintf("environment '%s/%s' not found: %v", namespace, name, err)})
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

	patchBytes, err := json.Marshal(req)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("marshal patch: %v", err)})
		return
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), 15*time.Second)
	defer cancel()

	patched, err := h.client.Resource(EnvironmentGVR).Namespace(namespace).Patch(ctx, name, types.MergePatchType, patchBytes, metav1.PatchOptions{})
	if err != nil {
		switch {
		case apierrors.IsNotFound(err):
			c.JSON(http.StatusNotFound, gin.H{"error": fmt.Sprintf("environment '%s/%s' not found", namespace, name)})
		case apierrors.IsConflict(err):
			c.JSON(http.StatusConflict, gin.H{"error": fmt.Sprintf("concurrent edit on '%s/%s': %v", namespace, name, err)})
		case apierrors.IsInvalid(err) || apierrors.IsBadRequest(err):
			c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("invalid patch: %v", err)})
		default:
			c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("patch environment: %v", err)})
		}
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
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("delete environment: %v", err)})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": fmt.Sprintf("environment '%s/%s' deletion requested", namespace, name)})
}

// --- LoadTest handlers ---

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
		c.JSON(http.StatusNotFound, gin.H{"error": fmt.Sprintf("loadtest '%s/%s' not found: %v", namespace, name, err)})
		return
	}

	detail := mapLoadTestDetail(*result)
	h.inlineScripts(ctx, namespace, &detail)

	c.JSON(http.StatusOK, detail)
}

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

	for i, pn := range req.PerNodeLoad {
		if pn.Script == "" && pn.ScriptConfigMap == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("perNodeLoad[%d]: script or scriptConfigMap required", i)})
			return
		}
		if pn.Script != "" && pn.ScriptConfigMap != "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("perNodeLoad[%d]: only one of script or scriptConfigMap allowed", i)})
			return
		}
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), 30*time.Second)
	defer cancel()

	envObj, err := h.client.Resource(EnvironmentGVR).Namespace(req.Namespace).Get(ctx, req.TargetEnvironment, metav1.GetOptions{})
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": fmt.Sprintf("environment '%s/%s' not found: %v", req.Namespace, req.TargetEnvironment, err)})
		return
	}

	phase := getNestedString(envObj.Object, "status", "phase")
	if !req.Suspended && req.StartAt == nil && phase != "Ready" {
		c.JSON(http.StatusConflict, gin.H{"error": fmt.Sprintf("environment '%s' is not Ready (current phase: %s)", req.TargetEnvironment, phase)})
		return
	}

	k6IDs := map[string]struct{}{}
	k6Status, _, _ := unstructured.NestedSlice(envObj.Object, "status", "k6Nodes")
	for _, kn := range k6Status {
		if m, ok := kn.(map[string]interface{}); ok {
			if id := getStringFromMap(m, "nodeID"); id != "" {
				k6IDs[id] = struct{}{}
			}
		}
	}
	if len(k6IDs) == 0 {
		nodes, _, _ := unstructured.NestedSlice(envObj.Object, "spec", "nodes")
		for _, n := range nodes {
			if m, ok := n.(map[string]interface{}); ok {
				if getStringFromMap(m, "role") == "k6-load-generator" {
					if id := getStringFromMap(m, "nodeID"); id != "" {
						k6IDs[id] = struct{}{}
					}
				}
			}
		}
	}

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
	}

	createdCMs := make([]string, 0, len(req.PerNodeLoad))
	cleanup := func() {
		for _, cmName := range createdCMs {
			_ = h.client.Resource(ConfigMapGVR).Namespace(req.Namespace).Delete(context.Background(), cmName, metav1.DeleteOptions{})
		}
	}

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
			cleanup()
			c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("create script configmap '%s': %v", cmName, err)})
			return
		}
		createdCMs = append(createdCMs, cmName)
		pn.ScriptConfigMap = cmName
	}

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
			c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("metricsExport.metrics[%d]: metricName required when type='custom-promql'", i)})
			cleanup()
			return
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
	if req.MetricsExport.GoogleDrive != nil {
		metricsExport["googleDrive"] = map[string]interface{}{
			"folderId":             req.MetricsExport.GoogleDrive.FolderID,
			"credentialsSecretRef": req.MetricsExport.GoogleDrive.CredentialsSecretRef,
		}
	}

	lt := &unstructured.Unstructured{
		Object: map[string]interface{}{
			"apiVersion": "dfaas.dfaas.io/v1",
			"kind":       "LoadTest",
			"metadata": map[string]interface{}{
				"name":      ltName,
				"namespace": req.Namespace,
			},
			"spec": map[string]interface{}{
				"targetEnvironment": req.TargetEnvironment,
				"perNodeLoad":       perNodeSpec,
				"metricsExport":     metricsExport,
			},
		},
	}
	if req.Suspended {
		spec := lt.Object["spec"].(map[string]interface{})
		spec["suspended"] = true
	}
	if req.StartAt != nil {
		spec := lt.Object["spec"].(map[string]interface{})
		spec["startAt"] = req.StartAt.UTC().Format(time.RFC3339)
	}

	created, err := h.client.Resource(LoadTestGVR).Namespace(req.Namespace).Create(ctx, lt, metav1.CreateOptions{})
	if err != nil {
		cleanup()
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("create loadtest: %v", err)})
		return
	}

	if len(createdCMs) > 0 {
		ownerRef := map[string]interface{}{
			"apiVersion":         "dfaas.dfaas.io/v1",
			"kind":               "LoadTest",
			"name":               created.GetName(),
			"uid":                string(created.GetUID()),
			"controller":         true,
			"blockOwnerDeletion": true,
		}
		patch, _ := json.Marshal(map[string]interface{}{
			"metadata": map[string]interface{}{
				"ownerReferences": []interface{}{ownerRef},
			},
		})
		for _, cmName := range createdCMs {
			_, _ = h.client.Resource(ConfigMapGVR).Namespace(req.Namespace).Patch(ctx, cmName, types.MergePatchType, patch, metav1.PatchOptions{})
		}
	}

	detail := mapLoadTestDetail(*created)
	h.inlineScripts(ctx, req.Namespace, &detail)

	c.JSON(http.StatusCreated, detail)
}

func (h *Handler) DeleteLoadTest(c *gin.Context) {
	namespace := c.Param("namespace")
	name := c.Param("name")

	ctx, cancel := context.WithTimeout(c.Request.Context(), 10*time.Second)
	defer cancel()

	if err := h.client.Resource(LoadTestGVR).Namespace(namespace).Delete(ctx, name, metav1.DeleteOptions{}); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("delete loadtest: %v", err)})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": fmt.Sprintf("loadtest '%s/%s' deletion requested", namespace, name)})
}

// --- Helpers ---

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

// --- Mappers ---

func mapEnvSummary(item unstructured.Unstructured) EnvironmentSummary {
	observedGen, _, _ := unstructured.NestedInt64(item.Object, "status", "observedGeneration")
	s := EnvironmentSummary{
		Name:               item.GetName(),
		Namespace:          item.GetNamespace(),
		Phase:              getNestedString(item.Object, "status", "phase"),
		Message:            getNestedString(item.Object, "status", "message"),
		CreationTimestamp:  item.GetCreationTimestamp().Time,
		Generation:         item.GetGeneration(),
		ObservedGeneration: observedGen,
	}

	nodes, _, _ := unstructured.NestedSlice(item.Object, "spec", "nodes")
	s.NodeCount = len(nodes)
	for _, n := range nodes {
		m, ok := n.(map[string]interface{})
		if !ok {
			continue
		}
		switch getStringFromMap(m, "role") {
		case "dfaas-worker":
			s.DfaasNodeCount++
		case "k6-load-generator":
			s.K6NodeCount++
		}
	}

	return s
}

func mapEnvDetail(item unstructured.Unstructured) EnvironmentDetail {
	observedGen, _, _ := unstructured.NestedInt64(item.Object, "status", "observedGeneration")
	d := EnvironmentDetail{
		Name:               item.GetName(),
		Namespace:          item.GetNamespace(),
		Phase:              getNestedString(item.Object, "status", "phase"),
		Message:            getNestedString(item.Object, "status", "message"),
		CreationTimestamp:  item.GetCreationTimestamp().Time,
		Generation:         item.GetGeneration(),
		ObservedGeneration: observedGen,
	}

	d.CleanupOnDelete, _, _ = unstructured.NestedBool(item.Object, "spec", "cleanupOnDelete")

	conditions, _, _ := unstructured.NestedSlice(item.Object, "status", "conditions")
	for _, c := range conditions {
		cMap, ok := c.(map[string]interface{})
		if !ok {
			continue
		}
		d.Conditions = append(d.Conditions, ConditionInfo{
			Type:               getStringFromMap(cMap, "type"),
			Status:             getStringFromMap(cMap, "status"),
			Reason:             getStringFromMap(cMap, "reason"),
			Message:            getStringFromMap(cMap, "message"),
			LastTransitionTime: getStringFromMap(cMap, "lastTransitionTime"),
		})
	}

	nodes, _, _ := unstructured.NestedSlice(item.Object, "spec", "nodes")
	for _, n := range nodes {
		nMap, ok := n.(map[string]interface{})
		if !ok {
			continue
		}
		node := NodeInfo{
			NodeID:            getStringFromMap(nMap, "nodeID"),
			IpAddress:         getStringFromMap(nMap, "ipAddress"),
			Role:              getStringFromMap(nMap, "role"),
			Username:          getStringFromMap(nMap, "username"),
			Password:          getStringFromMap(nMap, "password"),
			Capacity:          getStringFromMap(nMap, "capacity"),
			BalancingStrategy: getStringFromMap(nMap, "balancingStrategy"),
		}
		functions, _, _ := unstructured.NestedSlice(nMap, "functions")
		for _, f := range functions {
			fMap, ok := f.(map[string]interface{})
			if !ok {
				continue
			}
			node.Functions = append(node.Functions, FunctionInfo{
				Name:        getStringFromMap(fMap, "name"),
				Image:       getStringFromMap(fMap, "image"),
				ExecTimeout: getIntFromMap(fMap, "execTimeout"),
				MaxInflight: getIntFromMap(fMap, "maxInflight"),
				TimeoutMs:   getIntFromMap(fMap, "timeoutMs"),
				MaxRate:     getIntFromMap(fMap, "maxRate"),
			})
		}
		d.Nodes = append(d.Nodes, node)
	}

	links, _, _ := unstructured.NestedSlice(item.Object, "spec", "topology", "links")
	for _, l := range links {
		lMap, ok := l.(map[string]interface{})
		if !ok {
			continue
		}
		d.Topology.Links = append(d.Topology.Links, LinkInfo{
			NodeA:     getStringFromMap(lMap, "nodeA"),
			NodeB:     getStringFromMap(lMap, "nodeB"),
			LatencyMs: getIntFromMap(lMap, "latencyMs"),
		})
	}

	k6Status, _, _ := unstructured.NestedSlice(item.Object, "status", "k6Nodes")
	for _, k := range k6Status {
		kMap, ok := k.(map[string]interface{})
		if !ok {
			continue
		}
		d.K6Nodes = append(d.K6Nodes, K6NodeStatus{
			NodeID:           getStringFromMap(kMap, "nodeID"),
			IPAddress:        getStringFromMap(kMap, "ipAddress"),
			KubeconfigSecret: getStringFromMap(kMap, "kubeconfigSecret"),
		})
	}

	dfaasStatus, _, _ := unstructured.NestedSlice(item.Object, "status", "dfaasNodes")
	for _, n := range dfaasStatus {
		if s, ok := n.(string); ok {
			d.DfaasNodes = append(d.DfaasNodes, s)
		}
	}

	return d
}

func mapLoadTestSummary(item unstructured.Unstructured) LoadTestSummary {
	suspended, _, _ := unstructured.NestedBool(item.Object, "spec", "suspended")
	stop, _, _ := unstructured.NestedBool(item.Object, "spec", "stop")
	s := LoadTestSummary{
		Name:              item.GetName(),
		Namespace:         item.GetNamespace(),
		TargetEnvironment: getNestedString(item.Object, "spec", "targetEnvironment"),
		Phase:             getNestedString(item.Object, "status", "phase"),
		Suspended:         suspended,
		Stop:              stop,
		Message:           getNestedString(item.Object, "status", "message"),
		CreationTimestamp: item.GetCreationTimestamp().Time,
	}

	if t, ok := parseStatusTime(item.Object, "startTime"); ok {
		s.StartTime = &t
	}
	if t, ok := parseStatusTime(item.Object, "endTime"); ok {
		s.EndTime = &t
	}
	if startAtStr, ok, _ := unstructured.NestedString(item.Object, "spec", "startAt"); ok && startAtStr != "" {
		if t, err := time.Parse(time.RFC3339, startAtStr); err == nil {
			s.StartAt = &t
		}
	}

	return s
}

func mapLoadTestDetail(item unstructured.Unstructured) LoadTestDetail {
	d := LoadTestDetail{LoadTestSummary: mapLoadTestSummary(item)}

	perNode, _, _ := unstructured.NestedSlice(item.Object, "spec", "perNodeLoad")
	for _, pn := range perNode {
		m, ok := pn.(map[string]interface{})
		if !ok {
			continue
		}
		cmName := ""
		if cm, ok := m["scriptConfigMap"].(map[string]interface{}); ok {
			cmName = getStringFromMap(cm, "name")
		}
		d.PerNodeLoad = append(d.PerNodeLoad, PerNodeLoadView{
			NodeID:          getStringFromMap(m, "nodeID"),
			VUs:             getIntFromMap(m, "vus"),
			Duration:        getStringFromMap(m, "duration"),
			ScriptConfigMap: cmName,
		})
	}

	metrics, _, _ := unstructured.NestedSlice(item.Object, "spec", "metricsExport", "metrics")
	for _, m := range metrics {
		mp, ok := m.(map[string]interface{})
		if !ok {
			continue
		}
		d.MetricsExport.Metrics = append(d.MetricsExport.Metrics, MetricEntryView{
			Type:       getStringFromMap(mp, "type"),
			MetricName: getStringFromMap(mp, "metricName"),
			Query:      getStringFromMap(mp, "query"),
			Comment:    getStringFromMap(mp, "comment"),
		})
	}
	d.MetricsExport.Step = getNestedString(item.Object, "spec", "metricsExport", "step")
	if gd, _, _ := unstructured.NestedMap(item.Object, "spec", "metricsExport", "googleDrive"); gd != nil {
		d.MetricsExport.GoogleDrive = &GoogleDriveConfigView{
			FolderID:             getStringFromMap(gd, "folderId"),
			CredentialsSecretRef: getStringFromMap(gd, "credentialsSecretRef"),
		}
	}

	testRuns, _, _ := unstructured.NestedSlice(item.Object, "status", "testRuns")
	for _, tr := range testRuns {
		m, ok := tr.(map[string]interface{})
		if !ok {
			continue
		}
		d.TestRuns = append(d.TestRuns, TestRunRefView{
			NodeID:    getStringFromMap(m, "nodeID"),
			Name:      getStringFromMap(m, "name"),
			Namespace: getStringFromMap(m, "namespace"),
			Phase:     getStringFromMap(m, "phase"),
		})
	}

	d.ExporterJob = getNestedString(item.Object, "status", "exporterJob")

	conditions, _, _ := unstructured.NestedSlice(item.Object, "status", "conditions")
	for _, c := range conditions {
		cMap, ok := c.(map[string]interface{})
		if !ok {
			continue
		}
		d.Conditions = append(d.Conditions, ConditionInfo{
			Type:               getStringFromMap(cMap, "type"),
			Status:             getStringFromMap(cMap, "status"),
			Reason:             getStringFromMap(cMap, "reason"),
			Message:            getStringFromMap(cMap, "message"),
			LastTransitionTime: getStringFromMap(cMap, "lastTransitionTime"),
		})
	}

	return d
}

func parseStatusTime(obj map[string]interface{}, field string) (time.Time, bool) {
	raw := getNestedString(obj, "status", field)
	if raw == "" {
		return time.Time{}, false
	}
	t, err := time.Parse(time.RFC3339, raw)
	if err != nil {
		return time.Time{}, false
	}
	return t, true
}

var dns1123Sub = regexp.MustCompile(`[^a-z0-9-]+`)

func sanitizeDNS1123(s string) string {
	s = strings.ToLower(s)
	s = dns1123Sub.ReplaceAllString(s, "-")
	s = strings.Trim(s, "-")
	if len(s) > 253 {
		s = s[:253]
	}
	return s
}

func getNestedString(obj map[string]interface{}, fields ...string) string {
	val, _, _ := unstructured.NestedString(obj, fields...)
	return val
}

func getStringFromMap(m map[string]interface{}, key string) string {
	val, ok := m[key]
	if !ok {
		return ""
	}
	s, ok := val.(string)
	if !ok {
		return fmt.Sprintf("%v", val)
	}
	return s
}

func getIntFromMap(m map[string]interface{}, key string) int {
	val, ok := m[key]
	if !ok {
		return 0
	}
	switch v := val.(type) {
	case int64:
		return int(v)
	case float64:
		return int(v)
	case int:
		return v
	default:
		return 0
	}
}

// --- LoadTest activation ---

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
		switch {
		case apierrors.IsNotFound(err):
			c.JSON(http.StatusNotFound, gin.H{"error": fmt.Sprintf("loadtest '%s/%s' not found", namespace, name)})
		case apierrors.IsConflict(err):
			c.JSON(http.StatusConflict, gin.H{"error": fmt.Sprintf("concurrent edit on '%s/%s': %v", namespace, name, err)})
		default:
			c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("patch loadtest: %v", err)})
		}
		return
	}

	c.JSON(http.StatusAccepted, gin.H{
		"name":      name,
		"namespace": namespace,
		"stop":      true,
	})
}

// --- YAML export handlers ---

func (h *Handler) GetEnvironmentYAML(c *gin.Context) {
	h.exportResourceYAML(c, EnvironmentGVR, "environment")
}

func (h *Handler) GetLoadTestYAML(c *gin.Context) {
	h.exportResourceYAML(c, LoadTestGVR, "loadtest")
}

func (h *Handler) exportResourceYAML(c *gin.Context, gvr schema.GroupVersionResource, kind string) {
	namespace := c.Param("namespace")
	name := c.Param("name")

	ctx, cancel := context.WithTimeout(c.Request.Context(), 10*time.Second)
	defer cancel()

	obj, err := h.client.Resource(gvr).Namespace(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": fmt.Sprintf("%s '%s/%s' not found: %v", kind, namespace, name, err)})
		return
	}

	cleanForApply(obj.Object)

	yamlBytes, err := marshalOrderedYAML(obj.Object, kind)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("marshal %s yaml: %v", kind, err)})
		return
	}

	c.Header("Content-Disposition", fmt.Sprintf(`attachment; filename="%s-%s-%s.yaml"`, kind, namespace, name))
	c.Data(http.StatusOK, "application/yaml", yamlBytes)
}

// Preferred key order per path. Unknown keys at a level are appended
// alphabetically after the preferred ones. Paths use a synthetic notation:
// `root.spec.nodes[]` denotes "items of the nodes sequence under spec".
var envKeyOrder = map[string][]string{
	"root":                          {"apiVersion", "kind", "metadata", "spec"},
	"root.metadata":                 {"name", "namespace", "labels", "annotations"},
	"root.spec":                     {"cleanupOnDelete", "nodes", "topology"},
	"root.spec.nodes[]":             {"nodeID", "ipAddress", "role", "capacity", "username", "password", "balancingStrategy", "functions"},
	"root.spec.nodes[].functions[]": {"name", "image", "execTimeout", "maxInflight", "timeoutMs", "maxRate"},
	"root.spec.topology":            {"links"},
	"root.spec.topology.links[]":    {"nodeA", "nodeB", "latencyMs"},
}

var loadtestKeyOrder = map[string][]string{
	"root":                    {"apiVersion", "kind", "metadata", "spec"},
	"root.metadata":           {"name", "namespace", "labels", "annotations"},
	"root.spec":               {"targetEnvironment", "perNodeLoad", "metricsExport"},
	"root.spec.perNodeLoad[]": {"nodeID", "vus", "duration", "scriptConfigMap", "script"},
	"root.spec.perNodeLoad[].scriptConfigMap": {"name"},
	"root.spec.metricsExport":                 {"metrics", "step", "googleDrive"},
	"root.spec.metricsExport.metrics[]":       {"type", "metricName", "query", "comment"},
	"root.spec.metricsExport.googleDrive":     {"folderId", "credentialsSecretRef"},
}

func marshalOrderedYAML(obj map[string]interface{}, kind string) ([]byte, error) {
	order := envKeyOrder
	if kind == "loadtest" {
		order = loadtestKeyOrder
	}
	node, err := toOrderedYAMLNode(obj, order, "root")
	if err != nil {
		return nil, err
	}
	return yamlv3.Marshal(node)
}

func toOrderedYAMLNode(v interface{}, order map[string][]string, path string) (*yamlv3.Node, error) {
	switch x := v.(type) {
	case map[string]interface{}:
		n := &yamlv3.Node{Kind: yamlv3.MappingNode}
		for _, k := range orderedKeys(x, order[path]) {
			keyNode := &yamlv3.Node{Kind: yamlv3.ScalarNode, Value: k}
			valNode, err := toOrderedYAMLNode(x[k], order, path+"."+k)
			if err != nil {
				return nil, err
			}
			n.Content = append(n.Content, keyNode, valNode)
		}
		return n, nil
	case []interface{}:
		n := &yamlv3.Node{Kind: yamlv3.SequenceNode}
		for _, item := range x {
			ch, err := toOrderedYAMLNode(item, order, path+"[]")
			if err != nil {
				return nil, err
			}
			n.Content = append(n.Content, ch)
		}
		return n, nil
	default:
		n := &yamlv3.Node{}
		if err := n.Encode(v); err != nil {
			return nil, err
		}
		return n, nil
	}
}

func orderedKeys(m map[string]interface{}, preferred []string) []string {
	out := make([]string, 0, len(m))
	seen := make(map[string]bool, len(preferred))
	for _, k := range preferred {
		if _, ok := m[k]; ok {
			out = append(out, k)
			seen[k] = true
		}
	}
	rest := make([]string, 0)
	for k := range m {
		if !seen[k] {
			rest = append(rest, k)
		}
	}
	sort.Strings(rest)
	return append(out, rest...)
}

// cleanForApply strips server-managed metadata and status so the resulting
// YAML is safe to feed back into `kubectl apply -f` on a fresh namespace.
func cleanForApply(obj map[string]interface{}) {
	delete(obj, "status")
	md, _ := obj["metadata"].(map[string]interface{})
	if md == nil {
		return
	}
	for _, k := range []string{
		"resourceVersion", "uid", "generation",
		"creationTimestamp", "deletionTimestamp",
		"managedFields", "ownerReferences", "selfLink",
		"finalizers",
	} {
		delete(md, k)
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
