package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	utiljson "k8s.io/apimachinery/pkg/util/json"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	yamlv3 "gopkg.in/yaml.v3"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

// --- YAML apply handlers ---

// yamlValidator runs the gateway's business rules against a decoded CR before
// it is created. It returns the HTTP status and message the handler should
// send; ok is false in that case.
type yamlValidator func(ctx context.Context, namespace string, obj map[string]interface{}) (status int, msg string, ok bool)

// CreateEnvironmentFromYAML accepts a raw CR YAML body and creates an
// Environment, mirroring `kubectl apply -f` UX.
func (h *Handler) CreateEnvironmentFromYAML(c *gin.Context) {
	h.applyResourceYAML(c, EnvironmentGVR, "Environment", "dfaas.dfaas.io/v1", validateEnvironmentYAML)
}

// CreateLoadTestFromYAML accepts a raw CR YAML body and creates a LoadTest,
// mirroring `kubectl apply -f` UX.
func (h *Handler) CreateLoadTestFromYAML(c *gin.Context) {
	h.applyResourceYAML(c, LoadTestGVR, "LoadTest", "dfaas.dfaas.io/v1", h.validateLoadTestYAML)
}

// applyResourceYAML reads a YAML CR body, validates apiVersion+kind, scrubs
// server-managed fields, defaults namespace to "default", runs the kind's
// business-rule validator, and creates the resource via the dynamic client.
// Bypasses the typed DTO entirely so a user can round-trip a downloaded YAML
// (possibly with an edited metadata.name) — but not the gateway's rules, which
// would otherwise only fail later, as a confusing reconcile error.
func (h *Handler) applyResourceYAML(c *gin.Context, gvr schema.GroupVersionResource, expectedKind string, expectedAPIVersion string, validate yamlValidator) {
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
	// Normalise to what the API server receives: yaml.v3 decodes ints as int
	// and unquoted timestamps as time.Time, which the validators would have to
	// special-case and the dynamic fake client cannot deep-copy.
	if norm, err := normaliseJSON(obj); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("normalise yaml: %v", err)})
		return
	} else {
		obj = norm
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

	if status, msg, ok := validate(ctx, namespace, obj); !ok {
		c.JSON(status, gin.H{"error": msg})
		return
	}

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

// --- YAML business-rule validators ---
//
// These mirror the checks the structured JSON handlers run, so a pasted YAML
// gets the same clear 400/409 instead of a reconcile failure hours later.

// nestedSliceNoCopy reads a slice at the given path WITHOUT the deep copy
// unstructured.NestedSlice performs. The YAML decoder yields plain Go ints for
// numeric fields and that deep copy panics on any type outside the JSON set,
// so it must never be pointed at a freshly decoded YAML document.
func nestedSliceNoCopy(obj map[string]interface{}, fields ...string) []interface{} {
	raw, _, _ := unstructured.NestedFieldNoCopy(obj, fields...)
	s, _ := raw.([]interface{})
	return s
}

// validateEnvironmentYAML runs the same per-node shape checks CreateEnvironment
// enforces (role enum, capacity enum, required fields, duplicate nodeIDs).
func validateEnvironmentYAML(_ context.Context, _ string, obj map[string]interface{}) (int, string, bool) {
	rawNodes := nestedSliceNoCopy(obj, "spec", "nodes")
	if len(rawNodes) == 0 {
		return http.StatusBadRequest, "spec.nodes must contain at least one node", false
	}

	// The same projection the detail mapper uses. It used to be rebuilt here
	// from a different map, carrying only name + image -- so a function-level
	// rule added to the Rule set would silently not apply on this path.
	nodes, err := nodeInfosFrom(rawNodes)
	if err != nil {
		return http.StatusBadRequest, err.Error(), false
	}

	if err := validateEnvNodes(nodes); err != nil {
		return http.StatusBadRequest, err.Error(), false
	}
	return 0, "", true
}

// validateLoadTestYAML projects the document into the structured create's
// DTO and runs the same two checks CreateLoadTest runs: validateLoadTest on the
// shape, then admitAgainstEnvironment. One rule is the YAML path's own: every
// entry must reference a script ConfigMap, because the CRD carries no inline
// script.
func (h *Handler) validateLoadTestYAML(ctx context.Context, namespace string, obj map[string]interface{}) (int, string, bool) {
	req, err := loadTestRequestFrom(obj, namespace)
	if err != nil {
		return http.StatusBadRequest, err.Error(), false
	}
	for i, pn := range req.PerNodeLoad {
		if pn.ScriptConfigMap == "" {
			return http.StatusBadRequest, fmt.Sprintf("perNodeLoad[%d]: scriptConfigMap.name required (the CRD carries no inline script)", i), false
		}
	}
	if err := validateLoadTest(req); err != nil {
		return http.StatusBadRequest, err.Error(), false
	}

	envObj, err := h.client.Resource(EnvironmentGVR).Namespace(namespace).Get(ctx, req.TargetEnvironment, metav1.GetOptions{})
	if err != nil {
		if apierrors.IsNotFound(err) {
			return http.StatusBadRequest, fmt.Sprintf("environment '%s/%s' not found", namespace, req.TargetEnvironment), false
		}
		return http.StatusInternalServerError, fmt.Sprintf("read environment '%s/%s': %v", namespace, req.TargetEnvironment, err), false
	}
	return admitAgainstEnvironment(req, envObj)
}

// loadTestRequestFrom projects a normalised LoadTest document into the DTO
// the structured create binds, so both paths are validated by one function.
func loadTestRequestFrom(obj map[string]interface{}, namespace string) (CreateLoadTestRequest, error) {
	md, _ := obj["metadata"].(map[string]interface{})
	spec, _ := obj["spec"].(map[string]interface{})
	req := CreateLoadTestRequest{
		Name:              getStringFromMap(md, "name"),
		Namespace:         namespace,
		TargetEnvironment: getStringFromMap(spec, "targetEnvironment"),
	}
	req.Suspended, _, _ = unstructured.NestedBool(obj, "spec", "suspended")
	if v, ok := spec["startAt"]; ok && v != nil {
		raw, _ := v.(string)
		at, err := time.Parse(time.RFC3339, raw)
		if err != nil {
			return req, fmt.Errorf("startAt: '%v' is not an RFC3339 time", v)
		}
		req.StartAt = &at
	}
	for i, raw := range nestedSliceNoCopy(obj, "spec", "perNodeLoad") {
		e, ok := raw.(map[string]interface{})
		if !ok {
			return req, fmt.Errorf("perNodeLoad[%d] is not an object", i)
		}
		cmRef, _ := e["scriptConfigMap"].(map[string]interface{})
		req.PerNodeLoad = append(req.PerNodeLoad, CreatePerNodeLoad{
			NodeID:          getStringFromMap(e, "nodeID"),
			VUs:             getIntFromMap(e, "vus"),
			Duration:        getStringFromMap(e, "duration"),
			ScriptConfigMap: getStringFromMap(cmRef, "name"),
		})
	}
	for i, raw := range nestedSliceNoCopy(obj, "spec", "metricsExport", "metrics") {
		m, ok := raw.(map[string]interface{})
		if !ok {
			return req, fmt.Errorf("metricsExport.metrics[%d] is not an object", i)
		}
		req.MetricsExport.Metrics = append(req.MetricsExport.Metrics, CreateMetricEntry{
			Type:       getStringFromMap(m, "type"),
			MetricName: getStringFromMap(m, "metricName"),
			Query:      getStringFromMap(m, "query"),
			Comment:    getStringFromMap(m, "comment"),
		})
	}
	req.MetricsExport.Step = getNestedString(obj, "spec", "metricsExport", "step")
	return req, nil
}

// normaliseJSON round-trips obj through JSON, so numbers are int64/float64 and
// timestamps RFC3339 strings, exactly as the API server receives them.
func normaliseJSON(obj map[string]interface{}) (map[string]interface{}, error) {
	raw, err := json.Marshal(obj)
	if err != nil {
		return nil, err
	}
	var out map[string]interface{}
	if err := utiljson.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	return out, nil
}
