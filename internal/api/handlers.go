package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
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
		api.POST("/environments", h.CreateEnvironment)
		api.DELETE("/environments/:namespace/:name", h.DeleteEnvironment)

		api.GET("/loadtests", h.ListLoadTests)
		api.GET("/loadtests/:namespace/:name", h.GetLoadTest)
		api.POST("/loadtests", h.CreateLoadTest)
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

	for i, n := range req.Nodes {
		if n.NodeID == "" || n.IpAddress == "" || n.Role == "" || n.Capacity == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("node[%d]: nodeID, ipAddress, role, capacity required", i)})
			return
		}
		if n.Role != "dfaas-worker" && n.Role != "k6-load-generator" {
			c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("node[%d]: role must be dfaas-worker or k6-load-generator", i)})
			return
		}
		switch n.Capacity {
		case "LOW", "MEDIUM", "HIGH":
		default:
			c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("node[%d]: capacity must be LOW|MEDIUM|HIGH", i)})
			return
		}
		if n.Role == "k6-load-generator" {
			if n.BalancingStrategy != "" {
				c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("node[%d]: balancingStrategy must be empty for k6-load-generator", i)})
				return
			}
			if len(n.Functions) > 0 {
				c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("node[%d]: functions not allowed on k6-load-generator", i)})
				return
			}
		}
		if n.Role == "dfaas-worker" {
			if n.BalancingStrategy != "" {
				switch n.BalancingStrategy {
				case "staticstrategy", "nodemarginstrategy", "recalcstrategy", "alllocalstrategy", "rlagentstrategy":
				default:
					c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("node[%d]: balancingStrategy must be one of staticstrategy|nodemarginstrategy|recalcstrategy|alllocalstrategy|rlagentstrategy", i)})
					return
				}
			}
		}
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
	if phase != "Ready" {
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

	queries := make([]interface{}, 0, len(req.MetricsExport.Queries))
	for _, q := range req.MetricsExport.Queries {
		queries = append(queries, q)
	}

	metricsExport := map[string]interface{}{
		"queries": queries,
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
		if n.PrivateKey != "" {
			node["privateKey"] = n.PrivateKey
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
	s := EnvironmentSummary{
		Name:              item.GetName(),
		Namespace:         item.GetNamespace(),
		Phase:             getNestedString(item.Object, "status", "phase"),
		Message:           getNestedString(item.Object, "status", "message"),
		CreationTimestamp: item.GetCreationTimestamp().Time,
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
	d := EnvironmentDetail{
		Name:              item.GetName(),
		Namespace:         item.GetNamespace(),
		Phase:             getNestedString(item.Object, "status", "phase"),
		Message:           getNestedString(item.Object, "status", "message"),
		CreationTimestamp: item.GetCreationTimestamp().Time,
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
			PrivateKey:        getStringFromMap(nMap, "privateKey"),
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
	s := LoadTestSummary{
		Name:              item.GetName(),
		Namespace:         item.GetNamespace(),
		TargetEnvironment: getNestedString(item.Object, "spec", "targetEnvironment"),
		Phase:             getNestedString(item.Object, "status", "phase"),
		Message:           getNestedString(item.Object, "status", "message"),
		CreationTimestamp: item.GetCreationTimestamp().Time,
	}

	if t, ok := parseStatusTime(item.Object, "startTime"); ok {
		s.StartTime = &t
	}
	if t, ok := parseStatusTime(item.Object, "endTime"); ok {
		s.EndTime = &t
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

	queries, _, _ := unstructured.NestedSlice(item.Object, "spec", "metricsExport", "queries")
	for _, q := range queries {
		if s, ok := q.(string); ok {
			d.MetricsExport.Queries = append(d.MetricsExport.Queries, s)
		}
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
