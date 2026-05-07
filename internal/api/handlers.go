package api

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
)

// Handler contiene il client Kubernetes e gestisce le richieste HTTP.
type Handler struct {
	client dynamic.Interface
}

// NewHandler crea un nuovo handler con il client Kubernetes fornito.
func NewHandler(client dynamic.Interface) *Handler {
	return &Handler{client: client}
}

// RegisterRoutes registra tutte le rotte API sul router Gin.
func (h *Handler) RegisterRoutes(r *gin.Engine) {
	api := r.Group("/api")
	{
		api.GET("/experiments", h.ListExperiments)
		api.GET("/experiments/:namespace/:name", h.GetExperiment)
		api.POST("/k6/generate", h.GenerateK6)
		api.POST("/k6/upload", h.UploadK6Script)
		api.POST("/experiments/:namespace/:name/k6/launch", h.LaunchK6)
	}
}

// ListExperiments gestisce GET /api/experiments
// Lista tutti gli esperimenti da tutti i namespace.
func (h *Handler) ListExperiments(c *gin.Context) {
	ctx, cancel := context.WithTimeout(c.Request.Context(), 10*time.Second)
	defer cancel()

	// Lista da tutti i namespace (namespace vuoto = tutti)
	result, err := h.client.Resource(EsperimentoGVR).
		Namespace("").
		List(ctx, metav1.ListOptions{})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error": fmt.Sprintf("Errore nel recupero degli esperimenti: %v", err),
		})
		return
	}

	experiments := make([]ExperimentSummary, 0, len(result.Items))
	for _, item := range result.Items {
		experiments = append(experiments, mapToSummary(item))
	}

	c.JSON(http.StatusOK, gin.H{
		"experiments": experiments,
		"count":       len(experiments),
	})
}

// GetExperiment gestisce GET /api/experiments/:namespace/:name
// Restituisce il dettaglio completo di un singolo esperimento.
func (h *Handler) GetExperiment(c *gin.Context) {
	namespace := c.Param("namespace")
	name := c.Param("name")

	ctx, cancel := context.WithTimeout(c.Request.Context(), 10*time.Second)
	defer cancel()

	result, err := h.client.Resource(EsperimentoGVR).
		Namespace(namespace).
		Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{
			"error": fmt.Sprintf("Esperimento '%s/%s' non trovato: %v", namespace, name, err),
		})
		return
	}

	detail := mapToDetail(*result)
	c.JSON(http.StatusOK, detail)
}

// GenerateK6 gestisce POST /api/k6/generate
// Genera uno script k6 base e il manifest YAML TestRun.
func (h *Handler) GenerateK6(c *gin.Context) {
	var req K6GenerateRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": fmt.Sprintf("Parametri non validi: %v", err),
		})
		return
	}

	script, err := GenerateK6ScriptAdvanced(req)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error": fmt.Sprintf("Errore durante la generazione dello script: %v", err),
		})
		return
	}
	yaml := GenerateK6TestRunYAML(script, "load-test", "", req.MetricsQueries)

	c.JSON(http.StatusOK, K6GenerateResponse{
		Script: script,
		YAML:   yaml,
	})
}

// LaunchK6 genera lo script e lo lancia sul cluster (crea ConfigMap e TestRun)
func (h *Handler) LaunchK6(c *gin.Context) {
	namespace := c.Param("namespace")
	expName := c.Param("name")

	var req K6GenerateRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// 1. Genera lo script JS
	script, err := GenerateK6ScriptAdvanced(req)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("Errore generazione script: %v", err)})
		return
	}

	dynClient := h.client

	// 1.5 Recupera l'Esperimento per ottenere l'UID (per OwnerReferences)
	expGVR := schema.GroupVersionResource{Group: "dfaas.dfaas.io", Version: "v1", Resource: "esperimentos"}
	expObj, err := dynClient.Resource(expGVR).Namespace(namespace).Get(context.TODO(), expName, metav1.GetOptions{})
	var ownerRefs []interface{}
	if err == nil {
		ownerRefs = []interface{}{
			map[string]interface{}{
				"apiVersion":         "dfaas.dfaas.io/v1",
				"kind":               "Esperimento",
				"name":               expObj.GetName(),
				"uid":                expObj.GetUID(),
				"controller":         true,
				"blockOwnerDeletion": true,
			},
		}
	} else {
		fmt.Printf("Avviso: Impossibile recuperare l'Esperimento %s per impostare l'ownerReference: %v\n", expName, err)
	}

	timestamp := time.Now().Format("20060102-150405")
	baseName := fmt.Sprintf("%s-k6-%s", expName, timestamp)
	cmName := baseName + "-script"

	// 2. Crea ConfigMap
	cmMetadata := map[string]interface{}{
		"name":      cmName,
		"namespace": namespace,
	}
	if len(ownerRefs) > 0 {
		cmMetadata["ownerReferences"] = ownerRefs
	}

	cm := &unstructured.Unstructured{
		Object: map[string]interface{}{
			"apiVersion": "v1",
			"kind":       "ConfigMap",
			"metadata":   cmMetadata,
			"data": map[string]interface{}{
				"test.js": script,
			},
		},
	}
	cmGVR := schema.GroupVersionResource{Group: "", Version: "v1", Resource: "configmaps"}
	_, err = dynClient.Resource(cmGVR).Namespace(namespace).Create(context.TODO(), cm, metav1.CreateOptions{})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("Errore creazione ConfigMap: %v", err)})
		return
	}

	// 3. Crea TestRun
	trMetadata := map[string]interface{}{
		"name":      baseName,
		"namespace": namespace,
		"labels": map[string]interface{}{
			"dfaas.io/experiment-name": expName,
		},
	}
	
	if req.MetricsQueries != "" {
		trMetadata["annotations"] = map[string]interface{}{
			"dfaas.io/metrics-queries": req.MetricsQueries,
		}
	}
	
	if len(ownerRefs) > 0 {
		trMetadata["ownerReferences"] = ownerRefs
	}

	tr := &unstructured.Unstructured{
		Object: map[string]interface{}{
			"apiVersion": "k6.io/v1alpha1",
			"kind":       "TestRun",
			"metadata":   trMetadata,
			"spec": map[string]interface{}{
				"parallelism": int64(1),
				"script": map[string]interface{}{
					"configMap": map[string]interface{}{
						"name": cmName,
						"file": "test.js",
					},
				},
				"runner": map[string]interface{}{
					"image": "ghcr.io/grafana/k6:latest",
				},
			},
		},
	}
	trGVR := schema.GroupVersionResource{Group: "k6.io", Version: "v1alpha1", Resource: "testruns"}
	_, err = dynClient.Resource(trGVR).Namespace(namespace).Create(context.TODO(), tr, metav1.CreateOptions{})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("Errore creazione TestRun: %v", err)})
		return
	}

	yamlManifest := GenerateK6TestRunYAML(script, baseName, expName, req.MetricsQueries)

	c.JSON(http.StatusOK, gin.H{
		"message": fmt.Sprintf("TestRun '%s' avviato con successo nel namespace '%s'.", baseName, namespace),
		"script":  script,
		"yaml":    yamlManifest,
	})
}

// UploadK6Script gestisce POST /api/k6/upload
// Riceve un file .js e restituisce il contenuto come stringa + il YAML generato.
func (h *Handler) UploadK6Script(c *gin.Context) {
	file, header, err := c.Request.FormFile("script")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "File 'script' mancante nel body",
		})
		return
	}
	defer file.Close()

	content, err := io.ReadAll(file)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error": "Impossibile leggere il file",
		})
		return
	}

	script := string(content)
	// Per l'upload manuale passiamo stringhe vuote, non abbiamo metricsQueries dirette qui.
	yaml := GenerateK6TestRunYAML(script, "load-test-custom", "", "")

	c.JSON(http.StatusOK, gin.H{
		"filename": header.Filename,
		"script":   script,
		"yaml":     yaml,
	})
}

// --- Mapping functions ---
// Convertono le risorse Kubernetes unstructured nei DTOs tipizzati.

func mapToSummary(item unstructured.Unstructured) ExperimentSummary {
	phase := getNestedString(item.Object, "status", "phase")
	message := getNestedString(item.Object, "status", "message")

	// Conta i nodi nella federazione
	nodes, _, _ := unstructured.NestedSlice(item.Object, "spec", "federation", "nodes")

	creationTime := item.GetCreationTimestamp().Time

	return ExperimentSummary{
		Name:              item.GetName(),
		Namespace:         item.GetNamespace(),
		Phase:             phase,
		Message:           message,
		CreationTimestamp: creationTime,
		NodeCount:         len(nodes),
	}
}

func mapToDetail(item unstructured.Unstructured) ExperimentDetail {
	detail := ExperimentDetail{
		Name:              item.GetName(),
		Namespace:         item.GetNamespace(),
		Phase:             getNestedString(item.Object, "status", "phase"),
		Message:           getNestedString(item.Object, "status", "message"),
		CreationTimestamp: item.GetCreationTimestamp().Time,
	}

	// IsCleanupRequested
	cleanup, _, _ := unstructured.NestedBool(item.Object, "spec", "isCleanupRequested")
	detail.IsCleanupRequested = cleanup

	// Conditions
	conditions, _, _ := unstructured.NestedSlice(item.Object, "status", "conditions")
	for _, c := range conditions {
		cMap, ok := c.(map[string]interface{})
		if !ok {
			continue
		}
		detail.Conditions = append(detail.Conditions, ConditionInfo{
			Type:               getStringFromMap(cMap, "type"),
			Status:             getStringFromMap(cMap, "status"),
			Reason:             getStringFromMap(cMap, "reason"),
			Message:            getStringFromMap(cMap, "message"),
			LastTransitionTime: getStringFromMap(cMap, "lastTransitionTime"),
		})
	}

	// Federation nodes
	nodes, _, _ := unstructured.NestedSlice(item.Object, "spec", "federation", "nodes")
	for _, n := range nodes {
		nMap, ok := n.(map[string]interface{})
		if !ok {
			continue
		}
		node := NodeInfo{
			NodeID:            getStringFromMap(nMap, "nodeID"),
			IpAddress:         getStringFromMap(nMap, "ipAddress"),
			Username:          getStringFromMap(nMap, "username"),
			Password:          getStringFromMap(nMap, "password"),
			PrivateKey:        getStringFromMap(nMap, "privateKey"),
			Capacity:          getStringFromMap(nMap, "capacity"),
			BalancingStrategy: getStringFromMap(nMap, "balancingStrategy"),
		}

		// Functions
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
			})
		}

		detail.Federation.Nodes = append(detail.Federation.Nodes, node)
	}

	// Topology links
	links, _, _ := unstructured.NestedSlice(item.Object, "spec", "topology", "links")
	for _, l := range links {
		lMap, ok := l.(map[string]interface{})
		if !ok {
			continue
		}
		detail.Topology.Links = append(detail.Topology.Links, LinkInfo{
			NodeA:     getStringFromMap(lMap, "nodeA"),
			NodeB:     getStringFromMap(lMap, "nodeB"),
			LatencyMs: getIntFromMap(lMap, "latencyMs"),
		})
	}

	return detail
}

// --- Utility functions ---

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
