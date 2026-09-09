package api

import (
	"fmt"
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func mapEnvSummary(item unstructured.Unstructured) EnvironmentSummary {
	observedGen, _, _ := unstructured.NestedInt64(item.Object, "status", "observedGeneration")
	s := EnvironmentSummary{
		Name:               item.GetName(),
		Namespace:          item.GetNamespace(),
		Phase:              getNestedString(item.Object, "status", "phase"),
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
		CreationTimestamp:  item.GetCreationTimestamp().Time,
		Generation:         item.GetGeneration(),
		ObservedGeneration: observedGen,
	}

	d.LastHealthCheck = getNestedString(item.Object, "status", "lastHealthCheck")

	d.Conditions = mapConditions(item.Object)

	// The error is only reachable on a document the API server never produced
	// (a non-object node entry): the CRD schema forbids it. The YAML import
	// path calls the same projection and does surface it.
	d.Nodes, _ = nodeInfosFrom(nestedSliceNoCopy(item.Object, "spec", "nodes"))

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

	if ref, _, _ := unstructured.NestedMap(item.Object, "spec", "s3ConfigRef"); ref != nil {
		if name := getStringFromMap(ref, "name"); name != "" {
			d.S3ConfigRef = &S3ConfigRefView{Name: name}
		}
	}

	return d
}

func mapLoadTestSummary(item unstructured.Unstructured) LoadTestSummary {
	suspended, _, _ := unstructured.NestedBool(item.Object, "spec", "suspended")
	stop, _, _ := unstructured.NestedBool(item.Object, "spec", "stop")
	syncStart, _, _ := unstructured.NestedBool(item.Object, "spec", "syncStart")
	s := LoadTestSummary{
		Name:              item.GetName(),
		Namespace:         item.GetNamespace(),
		TargetEnvironment: getNestedString(item.Object, "spec", "targetEnvironment"),
		Phase:             getNestedString(item.Object, "status", "phase"),
		Suspended:         suspended,
		SyncStart:         syncStart,
		Stop:              stop,
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

	d.Conditions = mapConditions(item.Object)

	return d
}

// mapConditions projects status.conditions. One loop, two callers: mapEnvDetail
// and mapLoadTestDetail each carried a byte-identical 14-line copy of it, and
// the SPA has the same shape a third time in ProvisioningConditionRow.
//
// A missing status, a missing conditions key and a non-object entry are all the
// same answer: no condition. Nothing here can fail, so nothing here returns an
// error.
func mapConditions(obj map[string]interface{}) []ConditionInfo {
	var out []ConditionInfo
	for _, c := range nestedSliceNoCopy(obj, "status", "conditions") {
		cMap, ok := c.(map[string]interface{})
		if !ok {
			continue
		}
		out = append(out, ConditionInfo{
			Type:               getStringFromMap(cMap, "type"),
			Status:             getStringFromMap(cMap, "status"),
			Reason:             getStringFromMap(cMap, "reason"),
			Message:            getStringFromMap(cMap, "message"),
			LastTransitionTime: getStringFromMap(cMap, "lastTransitionTime"),
		})
	}
	return out
}

// nodeInfosFrom projects spec.nodes into NodeInfo. One projection, two callers,
// which is the point: mapEnvDetail built the full NodeInfo including all four
// Function tuning fields, while validateEnvironmentYAML rebuilt it from a
// different map for the SAME validator carrying only name + image. Harmless
// only because validateEnvNodes never inspected those fields -- adding a
// function-level rule to the Rule set would have silently not applied on the
// YAML import path, because the second projection dropped the inputs.
//
// Safe on both a cluster object and a freshly decoded YAML document: it reads
// through nestedSliceNoCopy, never unstructured.NestedSlice, whose deep copy
// panics on the plain Go ints yaml.v3 produces.
func nodeInfosFrom(raw []interface{}) ([]NodeInfo, error) {
	out := make([]NodeInfo, 0, len(raw))
	for i, entry := range raw {
		m, ok := entry.(map[string]interface{})
		if !ok {
			return nil, fmt.Errorf("spec.nodes[%d] is not an object", i)
		}
		node := NodeInfo{
			NodeID:            getStringFromMap(m, "nodeID"),
			IpAddress:         getStringFromMap(m, "ipAddress"),
			Role:              getStringFromMap(m, "role"),
			Username:          getStringFromMap(m, "username"),
			Password:          getStringFromMap(m, "password"),
			Capacity:          getStringFromMap(m, "capacity"),
			BalancingStrategy: getStringFromMap(m, "balancingStrategy"),
		}
		for j, rawFn := range nestedSliceNoCopy(m, "functions") {
			fn, ok := rawFn.(map[string]interface{})
			if !ok {
				return nil, fmt.Errorf("spec.nodes[%d].functions[%d] is not an object", i, j)
			}
			node.Functions = append(node.Functions, FunctionInfo{
				Name:        getStringFromMap(fn, "name"),
				Image:       getStringFromMap(fn, "image"),
				ExecTimeout: getIntFromMap(fn, "execTimeout"),
				MaxInflight: getIntFromMap(fn, "maxInflight"),
				TimeoutMs:   getIntFromMap(fn, "timeoutMs"),
				MaxRate:     getIntFromMap(fn, "maxRate"),
			})
		}
		out = append(out, node)
	}
	if len(out) == 0 {
		return nil, nil
	}
	return out, nil
}
