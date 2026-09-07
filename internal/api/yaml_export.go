package api

import (
	"context"
	"fmt"
	"net/http"
	"sort"
	"time"

	"github.com/gin-gonic/gin"
	yamlv3 "gopkg.in/yaml.v3"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

func (h *Handler) GetEnvironmentYAML(c *gin.Context) {
	h.exportResourceYAML(c, EnvironmentGVR, "environment")
}

func (h *Handler) GetLoadTestYAML(c *gin.Context) {
	h.exportResourceYAML(c, LoadTestGVR, "loadtest")
}

func (h *Handler) exportResourceYAML(c *gin.Context, gvr schema.GroupVersionResource, kind string) {
	namespace := c.Param("namespace")
	name := c.Param("name")

	ctx, cancel := context.WithTimeout(c.Request.Context(), 10*time.Second)
	defer cancel()

	obj, err := h.client.Resource(gvr).Namespace(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		writeK8sError(c, err, fmt.Sprintf("%s '%s/%s'", kind, namespace, name))
		return
	}

	cleanForApply(obj.Object)

	yamlBytes, err := marshalOrderedYAML(obj.Object, kind)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("marshal %s yaml: %v", kind, err)})
		return
	}

	c.Header("Content-Disposition", fmt.Sprintf(`attachment; filename="%s-%s-%s.yaml"`, kind, namespace, name))
	c.Data(http.StatusOK, "application/yaml", yamlBytes)
}

// Preferred key order per path. Unknown keys at a level are appended
// alphabetically after the preferred ones. Paths use a synthetic notation:
// `root.spec.nodes[]` denotes "items of the nodes sequence under spec".
var envKeyOrder = map[string][]string{
	"root":                          {"apiVersion", "kind", "metadata", "spec"},
	"root.metadata":                 {"name", "namespace", "labels", "annotations"},
	"root.spec":                     {"nodes", "topology", "s3ConfigRef"},
	"root.spec.nodes[]":             {"nodeID", "ipAddress", "role", "capacity", "username", "password", "balancingStrategy", "functions"},
	"root.spec.nodes[].functions[]": {"name", "image", "execTimeout", "maxInflight", "timeoutMs", "maxRate"},
	"root.spec.topology":            {"links"},
	"root.spec.topology.links[]":    {"nodeA", "nodeB", "latencyMs"},
	"root.spec.s3ConfigRef":         {"name"},
}

var loadtestKeyOrder = map[string][]string{
	"root":                    {"apiVersion", "kind", "metadata", "spec"},
	"root.metadata":           {"name", "namespace", "labels", "annotations"},
	"root.spec":               {"targetEnvironment", "syncStart", "perNodeLoad", "metricsExport"},
	"root.spec.perNodeLoad[]": {"nodeID", "vus", "duration", "scriptConfigMap", "script"},
	"root.spec.perNodeLoad[].scriptConfigMap": {"name"},
	"root.spec.metricsExport":                 {"metrics", "step"},
	"root.spec.metricsExport.metrics[]":       {"type", "metricName", "query", "comment"},
}

func marshalOrderedYAML(obj map[string]interface{}, kind string) ([]byte, error) {
	order := envKeyOrder
	if kind == "loadtest" {
		order = loadtestKeyOrder
	}
	node, err := toOrderedYAMLNode(obj, order, "root")
	if err != nil {
		return nil, err
	}
	return yamlv3.Marshal(node)
}

func toOrderedYAMLNode(v interface{}, order map[string][]string, path string) (*yamlv3.Node, error) {
	switch x := v.(type) {
	case map[string]interface{}:
		n := &yamlv3.Node{Kind: yamlv3.MappingNode}
		for _, k := range orderedKeys(x, order[path]) {
			keyNode := &yamlv3.Node{Kind: yamlv3.ScalarNode, Value: k}
			valNode, err := toOrderedYAMLNode(x[k], order, path+"."+k)
			if err != nil {
				return nil, err
			}
			n.Content = append(n.Content, keyNode, valNode)
		}
		return n, nil
	case []interface{}:
		n := &yamlv3.Node{Kind: yamlv3.SequenceNode}
		for _, item := range x {
			ch, err := toOrderedYAMLNode(item, order, path+"[]")
			if err != nil {
				return nil, err
			}
			n.Content = append(n.Content, ch)
		}
		return n, nil
	default:
		n := &yamlv3.Node{}
		if err := n.Encode(v); err != nil {
			return nil, err
		}
		return n, nil
	}
}

func orderedKeys(m map[string]interface{}, preferred []string) []string {
	out := make([]string, 0, len(m))
	seen := make(map[string]bool, len(preferred))
	for _, k := range preferred {
		if _, ok := m[k]; ok {
			out = append(out, k)
			seen[k] = true
		}
	}
	rest := make([]string, 0)
	for k := range m {
		if !seen[k] {
			rest = append(rest, k)
		}
	}
	sort.Strings(rest)
	return append(out, rest...)
}

// cleanForApply strips server-managed metadata and status so the resulting
// YAML is safe to feed back into `kubectl apply -f` on a fresh namespace.
func cleanForApply(obj map[string]interface{}) {
	delete(obj, "status")
	md, _ := obj["metadata"].(map[string]interface{})
	if md == nil {
		return
	}
	for _, k := range []string{
		"resourceVersion", "uid", "generation",
		"creationTimestamp", "deletionTimestamp",
		"managedFields", "ownerReferences", "selfLink",
		"finalizers",
	} {
		delete(md, k)
	}
}
