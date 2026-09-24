package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"
)

func loadTestObj(name, targetEnv, phase string, suspended bool, conds ...map[string]interface{}) *unstructured.Unstructured {
	status := map[string]interface{}{"phase": phase}
	if len(conds) > 0 {
		list := make([]interface{}, len(conds))
		for i, c := range conds {
			list[i] = c
		}
		status["conditions"] = list
	}
	return &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "dfaas.dfaas.io/v1",
		"kind":       "LoadTest",
		"metadata":   map[string]interface{}{"name": name, "namespace": "default"},
		"spec": map[string]interface{}{
			"targetEnvironment": targetEnv,
			"suspended":         suspended,
		},
		"status": status,
	}}
}

func k6Healthy(reason string) map[string]interface{} {
	return map[string]interface{}{"type": "K6Healthy", "status": "False", "reason": reason}
}

func envObj(name string) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "dfaas.dfaas.io/v1",
		"kind":       "Environment",
		"metadata": map[string]interface{}{
			"name": name, "namespace": "default", "generation": int64(3),
		},
		"spec":   map[string]interface{}{"nodes": []interface{}{}},
		"status": map[string]interface{}{"observedGeneration": int64(3)},
	}}
}

func guardHandler(objs ...runtime.Object) *Handler {
	s := runtime.NewScheme()
	listKinds := map[schema.GroupVersionResource]string{
		LoadTestGVR:    "LoadTestList",
		EnvironmentGVR: "EnvironmentList",
	}
	return &Handler{client: dynamicfake.NewSimpleDynamicClientWithCustomListKinds(s, listKinds, objs...)}
}

func patchEnv(t *testing.T, h *Handler, body map[string]interface{}) *httptest.ResponseRecorder {
	t.Helper()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.PATCH("/environments/:namespace/:name", h.UpdateEnvironment)

	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal body: %v", err)
	}
	req := httptest.NewRequest(http.MethodPatch, "/environments/default/env-demo", bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func twoRoleNodes() []map[string]interface{} {
	return []map[string]interface{}{
		{"nodeID": "worker-a", "ipAddress": "10.0.0.1", "role": "dfaas-worker",
			"capacity": "LOW", "username": "u", "password": "p", "balancingStrategy": "recalcstrategy",
			"functions": []interface{}{map[string]interface{}{"name": "figlet", "image": "ghcr.io/openfaas/figlet"}}},
		{"nodeID": "gen-b", "ipAddress": "10.0.0.2", "role": "k6-load-generator",
			"capacity": "LOW", "username": "u", "password": "p"},
	}
}

// Editing spec.nodes restarts the whole provisioning FSM, and a role flip now
// wipes the node's k3s outright. Neither may happen under a live experiment.
func TestUpdateEnvironmentRejectsWhileLoadTestActive(t *testing.T) {
	for _, tc := range []struct {
		name      string
		phase     string
		suspended bool
		conds     []map[string]interface{}
	}{
		{"running", "Running", false, nil},
		{"exporting", "Exporting", false, nil},
		{"pending not suspended", "Pending", false, nil},
		// The operator's Occupancy still holds the Environment on a terminal
		// test whose runner could not be deleted (runnersUnreclaimed in
		// loadtest_end.go): that runner may still be loading the nodes.
		{"failed with runners unreclaimed", "Failed", false, []map[string]interface{}{k6Healthy("RunnersUnreclaimed")}},
		{"aborted with runners unreclaimed", "Aborted", false, []map[string]interface{}{k6Healthy("RunnersUnreclaimed")}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := guardHandler(envObj("env-demo"), loadTestObj("lt-1", "env-demo", tc.phase, tc.suspended, tc.conds...))
			w := patchEnv(t, h, map[string]interface{}{"spec": map[string]interface{}{"nodes": twoRoleNodes()}})
			if w.Code != http.StatusConflict {
				t.Fatalf("got %d, want 409; body=%s", w.Code, w.Body.String())
			}
			if !bytes.Contains(w.Body.Bytes(), []byte("lt-1")) {
				t.Errorf("409 body does not name the offending load test: %s", w.Body.String())
			}
		})
	}
}

// Each entry carries its own remedy: a finished test with runners not
// reclaimed cannot be aborted, only deleted (or waited on). Same text as
// lt.holdReason in ui/src/lib/crstate.js: change both together.
func TestUpdateEnvironmentNamesTheRemedyPerTest(t *testing.T) {
	h := guardHandler(envObj("env-demo"),
		loadTestObj("lt-1", "env-demo", "Running", false),
		loadTestObj("lt-2", "env-demo", "Failed", false, k6Healthy("RunnersUnreclaimed")))
	w := patchEnv(t, h, map[string]interface{}{"spec": map[string]interface{}{"nodes": twoRoleNodes()}})
	want := `{"error":"environment is held by load tests: lt-1 (Running), lt-2 (Failed, runners not reclaimed: ` +
		`delete the test to release the Environment, up to 2 min); abort or wait for the running ones, ` +
		`delete the ones noted, before editing the Environment"}`
	if w.Code != http.StatusConflict || w.Body.String() != want {
		t.Fatalf("got %d %s\nwant 409 %s", w.Code, w.Body.String(), want)
	}
}

// A suspended Pending test is parked waiting for /activate and must not block
// edits forever; terminal phases are done with the nodes entirely.
func TestUpdateEnvironmentAllowsWhenNoLoadTestActive(t *testing.T) {
	for _, tc := range []struct {
		name      string
		phase     string
		suspended bool
		conds     []map[string]interface{}
	}{
		{"completed", "Completed", false, nil},
		{"failed", "Failed", false, nil},
		{"aborted", "Aborted", false, nil},
		{"pending but suspended", "Pending", true, nil},
		{"failed with runners reclaimed", "Failed", false, []map[string]interface{}{k6Healthy("RunnersReclaimed")}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := guardHandler(envObj("env-demo"), loadTestObj("lt-1", "env-demo", tc.phase, tc.suspended, tc.conds...))
			w := patchEnv(t, h, map[string]interface{}{"spec": map[string]interface{}{"nodes": twoRoleNodes()}})
			if w.Code != http.StatusAccepted {
				t.Fatalf("got %d, want 202; body=%s", w.Code, w.Body.String())
			}
		})
	}
}

// An active test on a DIFFERENT environment is none of this environment's
// business.
func TestUpdateEnvironmentIgnoresOtherEnvironmentsLoadTests(t *testing.T) {
	h := guardHandler(envObj("env-demo"), loadTestObj("lt-other", "env-other", "Running", false))
	w := patchEnv(t, h, map[string]interface{}{"spec": map[string]interface{}{"nodes": twoRoleNodes()}})
	if w.Code != http.StatusAccepted {
		t.Fatalf("got %d, want 202; body=%s", w.Code, w.Body.String())
	}
}

// Every spec edit bumps metadata.generation, and the operator re-provisions on
// any generation drift: an s3ConfigRef-only patch re-runs Ansible just like a
// node edit. So the guard covers every PATCH, and the s3 merge patch still goes
// through once no test is active.
func TestUpdateEnvironmentRejectsS3OnlyPatchDuringActiveLoadTest(t *testing.T) {
	bodies := map[string]map[string]interface{}{
		"set":   {"s3ConfigRef": map[string]interface{}{"name": "seaweedfs-default"}},
		"clear": {"clearS3ConfigRef": true},
	}
	for name, spec := range bodies {
		t.Run(name+" during active test", func(t *testing.T) {
			h := guardHandler(envObj("env-demo"), loadTestObj("lt-1", "env-demo", "Running", false))
			w := patchEnv(t, h, map[string]interface{}{"spec": spec})
			if w.Code != http.StatusConflict {
				t.Fatalf("got %d, want 409; body=%s", w.Code, w.Body.String())
			}
			if !bytes.Contains(w.Body.Bytes(), []byte("lt-1")) {
				t.Errorf("409 body does not name the offending load test: %s", w.Body.String())
			}
		})
		t.Run(name+" with no active test", func(t *testing.T) {
			h := guardHandler(envObj("env-demo"))
			w := patchEnv(t, h, map[string]interface{}{"spec": spec})
			if w.Code != http.StatusAccepted {
				t.Fatalf("got %d, want 202; body=%s", w.Code, w.Body.String())
			}
		})
	}
}

// Role flipping makes it easy to end up with an Environment that has nothing to
// load-test, or nothing to generate load with. Both are always a mistake.
func TestValidateEnvNodesRequiresBothRoles(t *testing.T) {
	worker := NodeInfo{NodeID: "a", IpAddress: "10.0.0.1", Role: "dfaas-worker",
		Capacity: "LOW", Username: "u", Password: "p", BalancingStrategy: "recalcstrategy",
		Functions: []FunctionInfo{{Name: "figlet", Image: "ghcr.io/openfaas/figlet"}}}
	gen := NodeInfo{NodeID: "b", IpAddress: "10.0.0.2", Role: "k6-load-generator",
		Capacity: "LOW", Username: "u", Password: "p"}

	if err := validateEnvNodes([]NodeInfo{worker, gen}); err != nil {
		t.Fatalf("valid pair rejected: %v", err)
	}
	if err := validateEnvNodes([]NodeInfo{worker}); err == nil {
		t.Error("worker-only node list accepted; expected a missing-generator error")
	}
	if err := validateEnvNodes([]NodeInfo{gen}); err == nil {
		t.Error("generator-only node list accepted; expected a missing-worker error")
	}
}
