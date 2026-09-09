package api

import (
	"strings"
	"testing"

	yamlv3 "gopkg.in/yaml.v3"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// Every byte the SPA consumes is produced by ~239 lines of hand-written
// unstructured field extraction, and none of it had a test. The invariant that
// makes the file safe is documented on one helper rather than at the type
// level: "A missing key or a non-string value both yield \"\": Go-formatted
// renderings of maps and slices (\"map[foo:bar]\") have no business leaking
// into a JSON response." getStringFromMap / getNestedString are called ~60
// times across the package on that promise.

func fullEnvObject() *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "dfaas.dfaas.io/v1",
		"kind":       "Environment",
		"metadata": map[string]interface{}{
			"name": "bari", "namespace": "default",
			"generation": int64(4), "uid": "uid-1",
			"creationTimestamp": "2026-09-09T10:00:00Z",
		},
		"spec": map[string]interface{}{
			"nodes": []interface{}{
				map[string]interface{}{
					"nodeID": "w1", "ipAddress": "10.0.0.1", "role": "dfaas-worker",
					"username": "u", "password": "p", "capacity": "MEDIUM",
					"balancingStrategy": "recalcstrategy",
					"functions": []interface{}{
						map[string]interface{}{
							"name": "figlet", "image": "ghcr.io/x/figlet:1",
							"execTimeout": int64(5), "maxInflight": int64(400),
							"timeoutMs": int64(6000), "maxRate": int64(100),
						},
					},
				},
				map[string]interface{}{
					"nodeID": "g4", "ipAddress": "10.0.0.2", "role": "k6-load-generator",
					"username": "u", "password": "p", "capacity": "LARGE",
				},
			},
			"s3ConfigRef": map[string]interface{}{"name": "seaweedfs-default"},
			"topology": map[string]interface{}{"links": []interface{}{
				map[string]interface{}{"nodeA": "w1", "nodeB": "g4", "latencyMs": int64(10)},
			}},
		},
		"status": map[string]interface{}{
			"phase":              "Ready",
			"observedGeneration": int64(4),
			"lastHealthCheck":    "2026-09-09T10:05:00Z",
			"conditions": []interface{}{
				map[string]interface{}{
					"type": "Ready", "status": "True", "reason": "AllSubsystemsReady",
					"message": "everything up", "lastTransitionTime": "2026-09-09T10:04:00Z",
				},
				map[string]interface{}{
					"type": "NodesReachable", "status": "True", "reason": "SSHReachable",
					"message":            "all declared nodes reachable on :22",
					"lastTransitionTime": "2026-09-09T10:04:00Z",
				},
			},
			"k6Nodes": []interface{}{
				map[string]interface{}{"nodeID": "g4", "kubeconfigSecret": "bari-g4-kubeconfig"},
			},
		},
	}}
}

func TestMapEnvDetailGolden(t *testing.T) {
	d := mapEnvDetail(*fullEnvObject())

	if d.Name != "bari" || d.Namespace != "default" {
		t.Errorf("identity: got %s/%s", d.Namespace, d.Name)
	}
	if d.Phase != "Ready" {
		t.Errorf("phase = %q", d.Phase)
	}
	if d.Generation != 4 || d.ObservedGeneration != 4 {
		t.Errorf("generations: %d / %d", d.Generation, d.ObservedGeneration)
	}
	if d.LastHealthCheck != "2026-09-09T10:05:00Z" {
		t.Errorf("lastHealthCheck = %q", d.LastHealthCheck)
	}

	if len(d.Conditions) != 2 {
		t.Fatalf("conditions = %d, want 2", len(d.Conditions))
	}
	c := d.Conditions[0]
	if c.Type != "Ready" || c.Status != "True" || c.Reason != "AllSubsystemsReady" ||
		c.Message != "everything up" || c.LastTransitionTime != "2026-09-09T10:04:00Z" {
		t.Errorf("condition[0] = %+v; all five fields must survive", c)
	}

	if len(d.Nodes) != 2 {
		t.Fatalf("nodes = %d, want 2", len(d.Nodes))
	}
	w1 := d.Nodes[0]
	if w1.NodeID != "w1" || w1.IpAddress != "10.0.0.1" || w1.Role != "dfaas-worker" ||
		w1.Username != "u" || w1.Password != "p" || w1.Capacity != "MEDIUM" ||
		w1.BalancingStrategy != "recalcstrategy" {
		t.Errorf("node[0] = %+v", w1)
	}
	if len(w1.Functions) != 1 {
		t.Fatalf("node[0].functions = %d, want 1", len(w1.Functions))
	}
	// All four tuning fields: the YAML import path used to drop them.
	fn := w1.Functions[0]
	if fn.Name != "figlet" || fn.Image != "ghcr.io/x/figlet:1" ||
		fn.ExecTimeout != 5 || fn.MaxInflight != 400 || fn.TimeoutMs != 6000 || fn.MaxRate != 100 {
		t.Errorf("function = %+v; every tuning field must survive", fn)
	}
	// A node with no functions must project an empty list, not a phantom entry.
	if len(d.Nodes[1].Functions) != 0 {
		t.Errorf("node[1].functions = %+v, want none", d.Nodes[1].Functions)
	}
}

// The zero-value invariant: an Environment whose status has never been written
// must produce a complete, empty-valued response rather than a partial one or
// a panic.
func TestMapEnvDetailWithNoStatus(t *testing.T) {
	obj := fullEnvObject()
	delete(obj.Object, "status")

	d := mapEnvDetail(*obj)

	if d.Phase != "" {
		t.Errorf("phase = %q, want empty", d.Phase)
	}
	if d.ObservedGeneration != 0 {
		t.Errorf("observedGeneration = %d, want 0", d.ObservedGeneration)
	}
	if d.LastHealthCheck != "" {
		t.Errorf("lastHealthCheck = %q, want empty", d.LastHealthCheck)
	}
	if len(d.Conditions) != 0 {
		t.Errorf("conditions = %+v, want none", d.Conditions)
	}
	// The spec is still there, so the nodes are still projected.
	if len(d.Nodes) != 2 {
		t.Errorf("nodes = %d, want 2 — a missing status must not hide the spec", len(d.Nodes))
	}
}

// A non-string value must yield "" rather than a Go-formatted rendering:
// "map[foo:bar]" in a JSON response is the failure this promise prevents.
func TestProjectionsNeverLeakGoFormatting(t *testing.T) {
	obj := &unstructured.Unstructured{Object: map[string]interface{}{
		"metadata": map[string]interface{}{"name": "bari", "namespace": "default"},
		"spec": map[string]interface{}{"nodes": []interface{}{
			map[string]interface{}{
				// Every one of these is the wrong type on purpose.
				"nodeID":    map[string]interface{}{"foo": "bar"},
				"ipAddress": []interface{}{"10.0.0.1"},
				"role":      int64(7),
			},
		}},
		"status": map[string]interface{}{
			"phase": map[string]interface{}{"nested": "value"},
			"conditions": []interface{}{
				map[string]interface{}{"type": []interface{}{"Ready"}, "status": int64(1)},
			},
		},
	}}

	d := mapEnvDetail(*obj)

	for name, got := range map[string]string{
		"phase":               d.Phase,
		"node[0].nodeID":      d.Nodes[0].NodeID,
		"node[0].ipAddress":   d.Nodes[0].IpAddress,
		"node[0].role":        d.Nodes[0].Role,
		"condition[0].type":   d.Conditions[0].Type,
		"condition[0].status": d.Conditions[0].Status,
	} {
		if got != "" {
			t.Errorf("%s = %q, want empty — a non-string value must not reach the wire", name, got)
		}
		if strings.HasPrefix(got, "map[") || strings.HasPrefix(got, "[") {
			t.Errorf("%s leaked a Go-formatted value: %q", name, got)
		}
	}
}

func TestMapLoadTestDetailConditions(t *testing.T) {
	obj := &unstructured.Unstructured{Object: map[string]interface{}{
		"metadata": map[string]interface{}{"name": "lt", "namespace": "default"},
		"spec":     map[string]interface{}{"targetEnvironment": "bari"},
		"status": map[string]interface{}{
			"phase": "Pending",
			"conditions": []interface{}{
				map[string]interface{}{
					"type": "Scheduled", "status": "True", "reason": "ScheduledArmed",
					"message":            "armed for 2026-09-09T12:00:00Z",
					"lastTransitionTime": "2026-09-09T10:00:00Z",
				},
			},
		},
	}}

	d := mapLoadTestDetail(*obj)
	if len(d.Conditions) != 1 {
		t.Fatalf("conditions = %d, want 1", len(d.Conditions))
	}
	// Both detail mappers must project conditions identically -- they carried
	// byte-identical copies of the loop, and the SPA looks reasons up by
	// string, so a dropped field is a silently blank panel.
	c := d.Conditions[0]
	if c.Type != "Scheduled" || c.Reason != "ScheduledArmed" ||
		c.Message == "" || c.LastTransitionTime == "" {
		t.Errorf("condition = %+v", c)
	}

	// And with no status at all.
	noStatus := &unstructured.Unstructured{Object: map[string]interface{}{
		"metadata": map[string]interface{}{"name": "lt", "namespace": "default"},
		"spec":     map[string]interface{}{"targetEnvironment": "bari"},
	}}
	if got := mapLoadTestDetail(*noStatus); got.Phase != "" || len(got.Conditions) != 0 {
		t.Errorf("with no status: phase=%q conditions=%+v", got.Phase, got.Conditions)
	}
}

// The landmine the projection had to be safe against: unstructured.NestedSlice
// deep-copies, and that copy panics on any type outside the JSON set. yaml.v3
// yields plain Go ints for numeric fields, so pointing NestedSlice at a freshly
// decoded YAML document panics -- and the only protection was a hand-discipline
// convention (use nestedSliceNoCopy) with no test and no type distinction.
//
// This turns the comment into an executable claim.
func TestNestedSliceNoCopySurvivesADecodedYAMLDocument(t *testing.T) {
	const doc = `
spec:
  nodes:
    - nodeID: w1
      ipAddress: 10.0.0.1
      role: dfaas-worker
      functions:
        - name: figlet
          image: ghcr.io/x/figlet:1
          execTimeout: 5
          maxInflight: 400
          timeoutMs: 6000
          maxRate: 100
`
	var obj map[string]interface{}
	if err := yamlv3.Unmarshal([]byte(doc), &obj); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	// First: prove the hazard is real, so this test cannot quietly stop
	// testing anything if the SDK changes.
	func() {
		defer func() {
			if recover() == nil {
				t.Error("unstructured.NestedSlice no longer panics on a decoded YAML document; " +
					"the nestedSliceNoCopy convention may no longer be needed")
			}
		}()
		_, _, _ = unstructured.NestedSlice(obj, "spec", "nodes")
	}()

	// Then: the no-copy read works, and the shared projection reads the plain
	// Go ints correctly rather than defaulting them to zero.
	raw := nestedSliceNoCopy(obj, "spec", "nodes")
	if len(raw) != 1 {
		t.Fatalf("nodes = %d, want 1", len(raw))
	}
	nodes, err := nodeInfosFrom(raw)
	if err != nil {
		t.Fatalf("nodeInfosFrom: %v", err)
	}
	if len(nodes) != 1 || len(nodes[0].Functions) != 1 {
		t.Fatalf("got %+v", nodes)
	}
	fn := nodes[0].Functions[0]
	if fn.ExecTimeout != 5 || fn.MaxInflight != 400 || fn.TimeoutMs != 6000 || fn.MaxRate != 100 {
		t.Errorf("function = %+v; yaml.v3's plain ints must be read, not defaulted to 0", fn)
	}
}

// A non-object entry is reported with its index, which is what lets the YAML
// import path answer 400 instead of failing at reconcile time.
func TestNodeInfosFromRejectsNonObjects(t *testing.T) {
	if _, err := nodeInfosFrom([]interface{}{"not-a-node"}); err == nil {
		t.Error("want an error for a non-object node entry")
	} else if !strings.Contains(err.Error(), "spec.nodes[0]") {
		t.Errorf("error should name the index: %v", err)
	}

	if _, err := nodeInfosFrom([]interface{}{
		map[string]interface{}{"nodeID": "w1", "functions": []interface{}{"not-a-function"}},
	}); err == nil {
		t.Error("want an error for a non-object function entry")
	} else if !strings.Contains(err.Error(), "functions[0]") {
		t.Errorf("error should name the function index: %v", err)
	}

	if nodes, err := nodeInfosFrom(nil); err != nil || nodes != nil {
		t.Errorf("no nodes must be (nil, nil), got (%+v, %v)", nodes, err)
	}
}
