package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func validPair() []NodeInfo {
	return []NodeInfo{
		{NodeID: "w1", IpAddress: "10.0.0.1", Role: "dfaas-worker", Capacity: "LOW", Username: "u", Password: "p", BalancingStrategy: "recalcstrategy"},
		{NodeID: "g1", IpAddress: "10.0.0.2", Role: "k6-load-generator", Capacity: "LOW", Username: "u", Password: "p"},
	}
}

// The four rules that used to exist only in the browser. A direct POST with
// any of these used to pass the gateway and come back as a raw API-server
// pattern rejection.
func TestValidateEnvNodesEnforcesCRDRules(t *testing.T) {
	if err := validateEnvNodes(validPair()); err != nil {
		t.Fatalf("valid pair rejected: %v", err)
	}
	cases := map[string]func([]NodeInfo) []NodeInfo{
		"uppercase nodeID": func(n []NodeInfo) []NodeInfo { n[0].NodeID = "G3"; return n },
		"nodeID over 63":   func(n []NodeInfo) []NodeInfo { n[0].NodeID = strings.Repeat("a", 64); return n },
		"ipAddress over 45": func(n []NodeInfo) []NodeInfo {
			n[0].IpAddress = strings.Repeat("1", 46)
			return n
		},
		"duplicate ipAddress": func(n []NodeInfo) []NodeInfo { n[1].IpAddress = n[0].IpAddress; return n },
		"over 50 nodes": func(n []NodeInfo) []NodeInfo {
			for i := 0; i < 49; i++ {
				n = append(n, NodeInfo{NodeID: "x" + strings.Repeat("a", i+1), IpAddress: "10.1.0." + string(rune('0'+i%10)) + string(rune('a'+i%26)),
					Role: "k6-load-generator", Capacity: "LOW", Username: "u", Password: "p"})
			}
			return n
		},
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			if err := validateEnvNodes(mutate(validPair())); err == nil {
				t.Errorf("%s accepted", name)
			}
		})
	}
}

// The served rules and the enforced rules are the same value, so the SPA and
// the gateway cannot drift.
func TestGetSchemaServesTheEnforcedRules(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	h := &Handler{}
	r.GET("/api/meta/schema", h.GetSchema)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/meta/schema", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("got %d", w.Code)
	}
	var got Schema
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Node.NodeIDPattern != dns1123LabelPattern || got.Node.MaxNodes != 50 || len(got.Node.Roles) != 2 {
		t.Errorf("served node rules differ from enforced: %+v", got.Node)
	}
	if got.LoadTest.GoDurationPattern != goDurationPattern {
		t.Errorf("served duration pattern differs")
	}
}

func TestValidateGoDuration(t *testing.T) {
	for _, ok := range []string{"30s", "1m30s", "2h", "500ms", "1.5m"} {
		if err := validateGoDuration("d", ok); err != nil {
			t.Errorf("%q rejected: %v", ok, err)
		}
	}
	for _, bad := range []string{"", "30", "1 m", "2d", "s30"} {
		if err := validateGoDuration("d", bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}
