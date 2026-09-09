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

// validateLoadTestYAML runs the business rules CreateLoadTest enforces: every
// perNodeLoad entry must reference a script ConfigMap (the CRD carries no
// inline script), the target Environment must exist and be dispatchable unless
// the test is a draft or scheduled, and every nodeID must be a k6 load
// generator of that Environment.
func (h *Handler) validateLoadTestYAML(ctx context.Context, namespace string, obj map[string]interface{}) (int, string, bool) {
	rawPerNode := nestedSliceNoCopy(obj, "spec", "perNodeLoad")
	if len(rawPerNode) == 0 {
		return http.StatusBadRequest, "spec.perNodeLoad must contain at least one entry", false
	}

	nodeIDs := make([]string, 0, len(rawPerNode))
	for i, raw := range rawPerNode {
		entry, ok := raw.(map[string]interface{})
		if !ok {
			return http.StatusBadRequest, fmt.Sprintf("spec.perNodeLoad[%d] is not an object", i), false
		}
		nodeID := getStringFromMap(entry, "nodeID")
		if nodeID == "" {
			return http.StatusBadRequest, fmt.Sprintf("spec.perNodeLoad[%d]: nodeID required", i), false
		}
		cmRef, _ := entry["scriptConfigMap"].(map[string]interface{})
		if getStringFromMap(cmRef, "name") == "" {
			return http.StatusBadRequest, fmt.Sprintf("spec.perNodeLoad[%d]: scriptConfigMap.name required (the CRD carries no inline script)", i), false
		}
		if err := validateGoDuration(fmt.Sprintf("spec.perNodeLoad[%d].duration", i), getStringFromMap(entry, "duration")); err != nil {
			return http.StatusBadRequest, err.Error(), false
		}
		nodeIDs = append(nodeIDs, nodeID)
	}

	// Same metric rules as the JSON path. Before this the custom-promql rule gave
	// a readable 400 on POST /loadtests and a raw CEL rejection here.
	for i, raw := range nestedSliceNoCopy(obj, "spec", "metricsExport", "metrics") {
		m, ok := raw.(map[string]interface{})
		if !ok {
			return http.StatusBadRequest, fmt.Sprintf("spec.metricsExport.metrics[%d] is not an object", i), false
		}
		mt := getStringFromMap(m, "type")
		if !hasEnum(rules.LoadTest.MetricTypes, mt) {
			return http.StatusBadRequest, fmt.Sprintf("spec.metricsExport.metrics[%d]: type must be %s", i, enumValues(rules.LoadTest.MetricTypes)), false
		}
		if mt == metricPromQL && getStringFromMap(m, "metricName") == "" {
			return http.StatusBadRequest, fmt.Sprintf("spec.metricsExport.metrics[%d]: metricName required when type='%s'", i, metricPromQL), false
		}
	}

	target := getNestedString(obj, "spec", "targetEnvironment")
	if target == "" {
		return http.StatusBadRequest, "spec.targetEnvironment required", false
	}

	envObj, err := h.client.Resource(EnvironmentGVR).Namespace(namespace).Get(ctx, target, metav1.GetOptions{})
	if err != nil {
		if apierrors.IsNotFound(err) {
			return http.StatusBadRequest, fmt.Sprintf("environment '%s/%s' not found", namespace, target), false
		}
		return http.StatusInternalServerError, fmt.Sprintf("read environment '%s/%s': %v", namespace, target, err), false
	}

	// Same admission rules as the structured path, same module. "Scheduled" is
	// decided on key presence: yaml.v3 resolves an unquoted RFC3339 value to a
	// time.Time, not to a string.
	suspended, _, _ := unstructured.NestedBool(obj, "spec", "suspended")
	spec, _ := obj["spec"].(map[string]interface{})
	intent := LoadTestIntent{
		TargetEnvironment: target,
		Suspended:         suspended,
		Scheduled:         spec["startAt"] != nil,
	}
	phase := getNestedString(envObj.Object, "status", "phase")
	if status, msg, ok := AdmitLoadTest(intent, phase); !ok {
		return status, msg, false
	}

	k6IDs := buildK6NodeIndex(envObj)
	for i, nodeID := range nodeIDs {
		if _, ok := k6IDs[nodeID]; !ok {
			valid := make([]string, 0, len(k6IDs))
			for id := range k6IDs {
				valid = append(valid, id)
			}
			return http.StatusBadRequest, fmt.Sprintf("spec.perNodeLoad[%d].nodeID '%s' not a k6-load-generator (valid: %v)", i, nodeID, valid), false
		}
	}

	return 0, "", true
}
