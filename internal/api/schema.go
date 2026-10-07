package api

import (
	"fmt"
	"k8s.io/apimachinery/pkg/util/validation"
	"net/http"
	"regexp"
	"strings"

	"github.com/gin-gonic/gin"
)

// Schema is the single rule set every Environment, LoadTest and S3Config write
// path validates against — JSON create, merge-patch and YAML import alike — and
// is served verbatim at GET /api/meta/schema so the SPA validates against the
// same rules instead of a hand-typed copy.
//
// Hand-synced with the operator CRDs in DFaaSOperator/api/v1/*_types.go. That
// is the one remaining hop under the cross-repo rule that the gateway carries
// no compile-time dependency on the operator's Go types; before this file the
// same rules were re-typed across six seams (form, component, binding tags,
// handler, YAML decoder, CRD) and four of them existed only in the browser.
type Schema struct {
	Node     NodeRules     `json:"node"`
	LoadTest LoadTestRules `json:"loadTest"`
	S3Config S3ConfigRules `json:"s3Config"`
}

// EnumOption pairs a protocol enum value with its human labels. Label is the
// long form for selects; ShortLabel (optional) is for dense read-only views.
type EnumOption struct {
	Value      string `json:"value"`
	Label      string `json:"label"`
	ShortLabel string `json:"shortLabel,omitempty"`
}

// NodeRules mirrors EnvironmentNode in environment_types.go plus the CEL and
// list-level constraints on spec.nodes.
type NodeRules struct {
	// NodeIDPattern is the DNS-1123 label regex (JS-compatible source): nodeID
	// becomes part of Kubernetes object names (kubeconfig Secret, libp2p key
	// entry, remote TestRun).
	NodeIDPattern       string       `json:"nodeIDPattern"`
	NodeIDMaxLength     int          `json:"nodeIDMaxLength"`
	IPAddressMaxLength  int          `json:"ipAddressMaxLength"`
	MaxNodes            int          `json:"maxNodes"`
	Roles               []EnumOption `json:"roles"`
	Capacities          []string     `json:"capacities"`
	BalancingStrategies []EnumOption `json:"balancingStrategies"`
	// UniqueIPAddress: one machine is one node (CRD CEL rule).
	UniqueIPAddress bool `json:"uniqueIPAddress"`
	// RequireEachRole: at least one dfaas-worker and one k6-load-generator.
	// Enforced here only — the CRD allows single-role Environments, which reach
	// Ready and then fail obscurely at dispatch.
	RequireEachRole bool `json:"requireEachRole"`

	// FunctionNamePattern mirrors the CRD Pattern on functions[].name (the
	// dfaas-agent's label parser accepts no '-' or '_').
	FunctionNamePattern string `json:"functionNamePattern"`
	// RequireWorkerFunction mirrors the CRD CEL rule: a dfaas-worker must
	// deploy at least one function.
	RequireWorkerFunction bool `json:"requireWorkerFunction"`
	// RequireCredentials: username (non-blank) and password on every node.
	// Gateway-only -- the CRD only requires the keys to be present, and an
	// empty value fails later as an Ansible SSH error.
	RequireCredentials bool `json:"requireCredentials"`
	// RequireFunctionImage: every function names an image. Gateway-only -- an
	// empty image is admitted by the CRD and fails at OpenFaaS deploy.
	RequireFunctionImage bool `json:"requireFunctionImage"`
}

// LoadTestRules mirrors the LoadTest CRD's per-node and metrics constraints.
type LoadTestRules struct {
	// GoDurationPattern is the CRD Pattern on perNodeLoad[].duration and
	// metricsExport.step.
	GoDurationPattern string       `json:"goDurationPattern"`
	MinVUs            int          `json:"minVUs"`
	MetricTypes       []EnumOption `json:"metricTypes"`
}

// S3ConfigRules: the Secret name is a Kubernetes object name.
type S3ConfigRules struct {
	NamePattern   string `json:"namePattern"`
	NameMaxLength int    `json:"nameMaxLength"`
}

const (
	dns1123LabelPattern = `^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`
	functionNamePattern = `^[a-z0-9]+$`
	// maxLoadTestNameLen: the LoadTest name is a label value (dfaas.io/loadtest
	// on its ConfigMaps, dfaas.io/loadtest-name on the remote TestRuns).
	maxLoadTestNameLen = 63
	goDurationPattern  = `^([0-9]+(\.[0-9]+)?(ns|us|ms|s|m|h))+$`

	roleWorker    = "dfaas-worker"
	roleGenerator = "k6-load-generator"
	metricRaw     = "raw"
	metricPromQL  = "custom-promql"
)

var (
	dns1123Re    = regexp.MustCompile(dns1123LabelPattern)
	functionRe   = regexp.MustCompile(functionNamePattern)
	goDurationRe = regexp.MustCompile(goDurationPattern)
)

// rules is the served value. Enum member lists and limits are the CRD's.
var rules = Schema{
	Node: NodeRules{
		NodeIDPattern:      dns1123LabelPattern,
		NodeIDMaxLength:    63,
		IPAddressMaxLength: 45,
		MaxNodes:           50,
		Roles: []EnumOption{
			{Value: roleWorker, Label: "DFaaS Node"},
			{Value: roleGenerator, Label: "k6 Load Generator"},
		},
		Capacities: []string{"LOW", "MEDIUM", "HIGH"},
		BalancingStrategies: []EnumOption{
			{Value: "staticstrategy", Label: "Static — fixed routing weights", ShortLabel: "Static"},
			{Value: "recalcstrategy", Label: "Recalc — rate-based (requires maxRate per fn)", ShortLabel: "Recalc"},
			{Value: "alllocalstrategy", Label: "All Local — keep traffic local", ShortLabel: "All Local"},
			{Value: "nodemarginstrategy", Label: "Node Margin (experimental)", ShortLabel: "Node Margin"},
			{Value: "rlagentstrategy", Label: "RL Agent (experimental)", ShortLabel: "RL Agent"},
			{Value: "randomstrategy", Label: "Random — random weights, no health check", ShortLabel: "Random"},
		},
		UniqueIPAddress:       true,
		RequireEachRole:       true,
		FunctionNamePattern:   functionNamePattern,
		RequireWorkerFunction: true,
		RequireCredentials:    true,
		RequireFunctionImage:  true,
	},
	LoadTest: LoadTestRules{
		GoDurationPattern: goDurationPattern,
		MinVUs:            1,
		MetricTypes: []EnumOption{
			{Value: metricRaw, Label: "Raw metric"},
			{Value: metricPromQL, Label: "Custom PromQL query"},
		},
	},
	S3Config: S3ConfigRules{
		NamePattern:   dns1123LabelPattern,
		NameMaxLength: 63,
	},
}

// GetSchema serves the rule set. Static, cacheable, no auth beyond the API's.
func (h *Handler) GetSchema(c *gin.Context) {
	c.JSON(http.StatusOK, rules)
}

func hasEnum(opts []EnumOption, v string) bool {
	for _, o := range opts {
		if o.Value == v {
			return true
		}
	}
	return false
}

func enumValues(opts []EnumOption) string {
	out := ""
	for i, o := range opts {
		if i > 0 {
			out += "|"
		}
		out += o.Value
	}
	return out
}

// validateEnvNodes is the one node-shape validator, shared by create, patch and
// YAML import. Every rule below has a counterpart in the served Schema.
func validateEnvNodes(nodes []NodeInfo) error {
	r := rules.Node
	if len(nodes) > r.MaxNodes {
		return fmt.Errorf("at most %d nodes per environment", r.MaxNodes)
	}
	seenID := map[string]struct{}{}
	seenIP := map[string]string{}
	var workers, generators int
	for i, n := range nodes {
		if n.NodeID == "" || n.IpAddress == "" || n.Role == "" || n.Capacity == "" {
			return fmt.Errorf("node[%d]: nodeID, ipAddress, role, capacity required", i)
		}
		if len(n.NodeID) > r.NodeIDMaxLength {
			return fmt.Errorf("node[%d]: nodeID must be at most %d characters", i, r.NodeIDMaxLength)
		}
		if !dns1123Re.MatchString(n.NodeID) {
			return fmt.Errorf("node[%d]: nodeID '%s' must be lowercase letters, digits and '-' (it becomes part of Kubernetes object names)", i, n.NodeID)
		}
		if _, dup := seenID[n.NodeID]; dup {
			return fmt.Errorf("node[%d]: duplicate nodeID '%s'", i, n.NodeID)
		}
		seenID[n.NodeID] = struct{}{}
		if len(n.IpAddress) > r.IPAddressMaxLength {
			return fmt.Errorf("node[%d]: ipAddress must be at most %d characters", i, r.IPAddressMaxLength)
		}
		if r.UniqueIPAddress {
			if other, dup := seenIP[n.IpAddress]; dup {
				return fmt.Errorf("nodes '%s' and '%s' share ipAddress %s: one machine is one node", other, n.NodeID, n.IpAddress)
			}
			seenIP[n.IpAddress] = n.NodeID
		}
		switch n.Role {
		case roleWorker:
			workers++
		case roleGenerator:
			generators++
		default:
			return fmt.Errorf("node[%d]: role must be %s", i, enumValues(r.Roles))
		}
		capOK := false
		for _, c := range r.Capacities {
			if c == n.Capacity {
				capOK = true
			}
		}
		if !capOK {
			return fmt.Errorf("node[%d]: capacity must be one of %v", i, r.Capacities)
		}
		if n.Role == roleGenerator {
			if n.BalancingStrategy != "" {
				return fmt.Errorf("node[%d]: balancingStrategy must be empty for %s", i, roleGenerator)
			}
			if len(n.Functions) > 0 {
				return fmt.Errorf("node[%d]: functions not allowed on %s", i, roleGenerator)
			}
		}
		if n.Role == roleWorker && n.BalancingStrategy != "" && !hasEnum(r.BalancingStrategies, n.BalancingStrategy) {
			return fmt.Errorf("node[%d]: balancingStrategy must be one of %s", i, enumValues(r.BalancingStrategies))
		}
		if r.RequireCredentials {
			if strings.TrimSpace(n.Username) == "" {
				return fmt.Errorf("node[%d]: username required", i)
			}
			if n.Password == "" {
				return fmt.Errorf("node[%d]: password required", i)
			}
		}
		if n.Role == roleWorker && r.RequireWorkerFunction && len(n.Functions) == 0 {
			return fmt.Errorf("node[%d]: a DFaaS node must deploy at least one function", i)
		}
		for j, fn := range n.Functions {
			f := fmt.Sprintf("node[%d].functions[%d]", i, j)
			if !functionRe.MatchString(fn.Name) {
				return fmt.Errorf("%s: function name '%s' must be lowercase letters and digits only", f, fn.Name)
			}
			if r.RequireFunctionImage && strings.TrimSpace(fn.Image) == "" {
				return fmt.Errorf("%s: image required", f)
			}
			// Unserved sign check: 0 means "CRD default", a negative value is a
			// raw 422 on PATCH and silently dropped on create.
			for name, v := range map[string]int{"execTimeout": fn.ExecTimeout, "maxInflight": fn.MaxInflight,
				"timeoutMs": fn.TimeoutMs, "maxRate": fn.MaxRate} {
				if v < 0 {
					return fmt.Errorf("%s: %s must not be negative", f, name)
				}
			}
		}
	}

	// Role composition. Nothing downstream rejects a single-role Environment:
	// ensureAnsibleJob skips a role with zero nodes and reports its condition
	// True, so the Environment reaches Ready and only fails obscurely once a
	// LoadTest is dispatched at it.
	if r.RequireEachRole {
		if workers == 0 {
			return fmt.Errorf("at least one node must have role %s: an environment with no DFaaS nodes has nothing to load-test", roleWorker)
		}
		if generators == 0 {
			return fmt.Errorf("at least one node must have role %s: an environment with no generators cannot run a load test", roleGenerator)
		}
	}
	return nil
}

// validateGoDuration mirrors the CRD Pattern so the user gets a readable 400
// instead of a raw 422.
func validateGoDuration(field, v string) error {
	if !goDurationRe.MatchString(v) {
		return fmt.Errorf("%s: '%s' is not a Go duration (e.g. 30s, 1m30s, 2h)", field, v)
	}
	return nil
}

// validateLoadTest runs every shape rule of the Rule set on one LoadTest
// submission, before any cluster call. Both create paths call it: POST
// /loadtests on the bound DTO, the YAML import on its projection.
func validateLoadTest(req CreateLoadTestRequest) error {
	if req.Name != "" {
		if len(req.Name) > maxLoadTestNameLen || len(validation.IsDNS1123Subdomain(req.Name)) > 0 {
			return fmt.Errorf("name '%s' must be a lowercase DNS-1123 name of at most %d characters (it becomes a label value)",
				req.Name, maxLoadTestNameLen)
		}
	}
	if req.TargetEnvironment == "" {
		return fmt.Errorf("targetEnvironment required")
	}
	if len(req.PerNodeLoad) == 0 {
		return fmt.Errorf("perNodeLoad must contain at least one entry")
	}
	seen := map[string]bool{}
	for i, pn := range req.PerNodeLoad {
		f := fmt.Sprintf("perNodeLoad[%d]", i)
		if pn.NodeID == "" {
			return fmt.Errorf("%s.nodeID required", f)
		}
		if (pn.Script == "") == (pn.ScriptConfigMap == "") {
			return fmt.Errorf("%s: set exactly one of script or scriptConfigMap", f)
		}
		if pn.VUs < rules.LoadTest.MinVUs {
			return fmt.Errorf("%s.vus must be at least %d", f, rules.LoadTest.MinVUs)
		}
		if err := validateGoDuration(f+".duration", pn.Duration); err != nil {
			return err
		}
		if seen[pn.NodeID] {
			return fmt.Errorf("%s: duplicate nodeID '%s'", f, pn.NodeID)
		}
		seen[pn.NodeID] = true
	}
	m := req.MetricsExport
	if len(m.Metrics) == 0 {
		return fmt.Errorf("metricsExport.metrics must contain at least one metric")
	}
	for i, e := range m.Metrics {
		f := fmt.Sprintf("metricsExport.metrics[%d]", i)
		if !hasEnum(rules.LoadTest.MetricTypes, e.Type) {
			return fmt.Errorf("%s: type must be %s", f, enumValues(rules.LoadTest.MetricTypes))
		}
		if strings.TrimSpace(e.Query) == "" {
			return fmt.Errorf("%s: query required", f)
		}
		if e.Type == metricPromQL && e.MetricName == "" {
			return fmt.Errorf("%s: metricName required when type='%s'", f, metricPromQL)
		}
	}
	if m.Step != "" {
		if err := validateGoDuration("metricsExport.step", m.Step); err != nil {
			return err
		}
	}
	return nil
}
