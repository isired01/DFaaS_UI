package api

import (
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
