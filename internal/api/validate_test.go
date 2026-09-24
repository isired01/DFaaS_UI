package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// One validator for both LoadTest create paths, and the CRD's node rules in
// the gateway's Rule set. Before, POST /loadtests and the YAML import each
// re-typed the Rule set with different gaps (metricsExport.step on neither,
// minVUs only on JSON), and three Environment rules lived only in the
// browser, so a direct POST or a YAML import got a raw API-server 422.

func validLoadTestRequest() CreateLoadTestRequest {
	return CreateLoadTestRequest{
		Namespace:         "default",
		TargetEnvironment: "env-demo",
		PerNodeLoad:       []CreatePerNodeLoad{{NodeID: "gen-a", VUs: 1, Duration: "30s", ScriptConfigMap: "s"}},
		MetricsExport: CreateMetricsExport{
			Metrics: []CreateMetricEntry{{Type: metricRaw, Query: "up"}},
		},
	}
}

func TestValidateLoadTest(t *testing.T) {
	for _, tc := range []struct {
		name    string
		mutate  func(*CreateLoadTestRequest)
		wantErr string
	}{
		{name: "valid", mutate: func(*CreateLoadTestRequest) {}},
		{name: "vus below minVUs", mutate: func(r *CreateLoadTestRequest) { r.PerNodeLoad[0].VUs = 0 }, wantErr: "vus"},
		{name: "bad duration", mutate: func(r *CreateLoadTestRequest) { r.PerNodeLoad[0].Duration = "5 minutes" }, wantErr: "duration"},
		{name: "bad step", mutate: func(r *CreateLoadTestRequest) { r.MetricsExport.Step = "5 minutes" }, wantErr: "metricsExport.step"},
		{name: "no script", mutate: func(r *CreateLoadTestRequest) { r.PerNodeLoad[0].ScriptConfigMap = "" }, wantErr: "script"},
		{name: "duplicate nodeID", mutate: func(r *CreateLoadTestRequest) {
			r.PerNodeLoad = append(r.PerNodeLoad, r.PerNodeLoad[0])
		}, wantErr: "duplicate nodeID"},
		{name: "no metrics", mutate: func(r *CreateLoadTestRequest) { r.MetricsExport.Metrics = nil }, wantErr: "metric"},
		{name: "empty query", mutate: func(r *CreateLoadTestRequest) { r.MetricsExport.Metrics[0].Query = "" }, wantErr: "query"},
		{name: "unknown metric type", mutate: func(r *CreateLoadTestRequest) { r.MetricsExport.Metrics[0].Type = "sql" }, wantErr: "type"},
		{name: "promql without metricName", mutate: func(r *CreateLoadTestRequest) {
			r.MetricsExport.Metrics[0].Type = metricPromQL
		}, wantErr: "metricName"},
		{name: "name too long for a label value", mutate: func(r *CreateLoadTestRequest) { r.Name = strings.Repeat("a", 64) }, wantErr: "name"},
		{name: "name not DNS-1123", mutate: func(r *CreateLoadTestRequest) { r.Name = "Bad_Name" }, wantErr: "name"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := validLoadTestRequest()
			tc.mutate(&req)
			err := validateLoadTest(req)
			if tc.wantErr == "" {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("error = %v, want one mentioning %q", err, tc.wantErr)
			}
		})
	}
}

func TestGeneratedLoadTestNameFitsALabelValue(t *testing.T) {
	name := generatedLoadTestName(strings.Repeat("environment", 6), "saturation-run", time.Now(), "abc123")
	if len(name) > 63 {
		t.Fatalf("generated name is %d bytes, want <= 63: %s", len(name), name)
	}
	if !strings.HasSuffix(name, "-abc123") || strings.Contains(name, "--") {
		t.Fatalf("generated name %q lost its nonce or kept a dangling '-'", name)
	}
}

func post(t *testing.T, h *Handler, path, contentType string, body []byte) *httptest.ResponseRecorder {
	t.Helper()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.POST("/loadtests", h.CreateLoadTest)
	r.POST("/loadtests/yaml", h.CreateLoadTestFromYAML)
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(body))
	req.Header.Set("Content-Type", contentType)
	r.ServeHTTP(w, req)
	return w
}

func TestBothCreatePathsRejectABadStep(t *testing.T) {
	req := validLoadTestRequest()
	req.MetricsExport.Step = "5 minutes"
	raw, _ := json.Marshal(req)
	w := post(t, guardHandler(), "/loadtests", "application/json", raw)
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "metricsExport.step") {
		t.Errorf("JSON path: %d %s, want 400 naming metricsExport.step", w.Code, w.Body.String())
	}

	yamlDoc := `apiVersion: dfaas.dfaas.io/v1
kind: LoadTest
metadata: {name: lt-yaml, namespace: default}
spec:
  targetEnvironment: env-demo
  perNodeLoad:
  - {nodeID: gen-a, vus: 1, duration: 30s, scriptConfigMap: {name: s}}
  metricsExport:
    step: 5 minutes
    metrics: [{type: raw, query: up}]
`
	w = post(t, guardHandler(), "/loadtests/yaml", "application/yaml", []byte(yamlDoc))
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "metricsExport.step") {
		t.Errorf("YAML path: %d %s, want 400 naming metricsExport.step", w.Code, w.Body.String())
	}
}

// A missing Environment is a missing resource on both paths, not a bad body.
func TestBothCreatePathsAnswer404ForAMissingEnvironment(t *testing.T) {
	const want = "environment 'default/env-demo' not found"
	raw, _ := json.Marshal(validLoadTestRequest())
	w := post(t, guardHandler(), "/loadtests", "application/json", raw)
	if w.Code != http.StatusNotFound || !strings.Contains(w.Body.String(), want) {
		t.Errorf("JSON path: %d %s, want 404 with %q", w.Code, w.Body.String(), want)
	}

	yamlDoc := `apiVersion: dfaas.dfaas.io/v1
kind: LoadTest
metadata: {name: lt-yaml, namespace: default}
spec:
  targetEnvironment: env-demo
  perNodeLoad:
  - {nodeID: gen-a, vus: 1, duration: 30s, scriptConfigMap: {name: s}}
  metricsExport:
    metrics: [{type: raw, query: up}]
`
	w = post(t, guardHandler(), "/loadtests/yaml", "application/yaml", []byte(yamlDoc))
	if w.Code != http.StatusNotFound || !strings.Contains(w.Body.String(), want) {
		t.Errorf("YAML path: %d %s, want 404 with %q", w.Code, w.Body.String(), want)
	}
}

func TestYAMLImportEnforcesMinVUs(t *testing.T) {
	yamlDoc := `apiVersion: dfaas.dfaas.io/v1
kind: LoadTest
metadata: {name: lt-yaml, namespace: default}
spec:
  targetEnvironment: env-demo
  perNodeLoad:
  - {nodeID: gen-a, vus: 0, duration: 30s, scriptConfigMap: {name: s}}
  metricsExport:
    metrics: [{type: raw, query: up}]
`
	w := post(t, guardHandler(), "/loadtests/yaml", "application/yaml", []byte(yamlDoc))
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "vus") {
		t.Errorf("%d %s, want 400 naming vus", w.Code, w.Body.String())
	}
}

func validNodes() []NodeInfo {
	return []NodeInfo{
		{NodeID: "w1", IpAddress: "10.0.0.1", Role: roleWorker, Capacity: "LOW", Username: "u", Password: "p",
			Functions: []FunctionInfo{{Name: "figlet", Image: "ghcr.io/openfaas/figlet"}}},
		{NodeID: "g1", IpAddress: "10.0.0.2", Role: roleGenerator, Capacity: "LOW", Username: "u", Password: "p"},
	}
}

func TestValidateEnvNodesMirrorsTheCRDNodeRules(t *testing.T) {
	for _, tc := range []struct {
		name    string
		mutate  func([]NodeInfo)
		wantErr string
	}{
		{name: "valid", mutate: func([]NodeInfo) {}},
		{name: "DFaaS node without functions", mutate: func(n []NodeInfo) { n[0].Functions = nil }, wantErr: "function"},
		{name: "blank username", mutate: func(n []NodeInfo) { n[1].Username = "  " }, wantErr: "username"},
		{name: "empty password", mutate: func(n []NodeInfo) { n[1].Password = "" }, wantErr: "password"},
		{name: "function name not [a-z0-9]", mutate: func(n []NodeInfo) { n[0].Functions[0].Name = "fig-let" }, wantErr: "function name"},
		{name: "empty function image", mutate: func(n []NodeInfo) { n[0].Functions[0].Image = "" }, wantErr: "image"},
		{name: "negative tuning", mutate: func(n []NodeInfo) { n[0].Functions[0].ExecTimeout = -1 }, wantErr: "execTimeout"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			nodes := validNodes()
			tc.mutate(nodes)
			err := validateEnvNodes(nodes)
			if tc.wantErr == "" {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("error = %v, want one mentioning %q", err, tc.wantErr)
			}
		})
	}
	if rules.Node.FunctionNamePattern != `^[a-z0-9]+$` || !rules.Node.RequireWorkerFunction ||
		!rules.Node.RequireCredentials || !rules.Node.RequireFunctionImage {
		t.Errorf("served node rules = %+v, want the function-name pattern and the three requirements", rules.Node)
	}
}

// The gateway's "would an Environment edit destroy this test" set must contain the
// operator's busy set: a non-suspended test not yet admitted ("") is about to
// dispatch.
func TestActiveLoadTestsCountAnUnadmittedTest(t *testing.T) {
	items := []unstructured.Unstructured{*loadTestObj("lt-new", "env-demo", "", false)}
	if got := activeLoadTestNames(items, "default", "env-demo"); len(got) != 1 {
		t.Fatalf("activeLoadTestNames = %v, want the unadmitted test counted", got)
	}
}
