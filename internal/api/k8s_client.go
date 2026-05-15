package api

import (
	"fmt"
	"os"
	"path/filepath"

	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
)

// EnvironmentGVR is the GroupVersionResource of the operator's Environment CRD.
var EnvironmentGVR = schema.GroupVersionResource{
	Group:    "dfaas.dfaas.io",
	Version:  "v1",
	Resource: "environments",
}

// LoadTestGVR is the GroupVersionResource of the operator's LoadTest CRD.
var LoadTestGVR = schema.GroupVersionResource{
	Group:    "dfaas.dfaas.io",
	Version:  "v1",
	Resource: "loadtests",
}

// ConfigMapGVR is the GVR for core/v1 ConfigMaps, used to materialize k6 scripts.
var ConfigMapGVR = schema.GroupVersionResource{
	Group:    "",
	Version:  "v1",
	Resource: "configmaps",
}

// NewK8sClient builds a dynamic Kubernetes client.
// In-cluster config first, then KUBECONFIG env, then ~/.kube/config.
func NewK8sClient() (dynamic.Interface, error) {
	config, err := rest.InClusterConfig()
	if err != nil {
		kubeconfig := os.Getenv("KUBECONFIG")
		if kubeconfig == "" {
			home, _ := os.UserHomeDir()
			kubeconfig = filepath.Join(home, ".kube", "config")
		}

		config, err = clientcmd.BuildConfigFromFlags("", kubeconfig)
		if err != nil {
			return nil, fmt.Errorf("kubernetes config: %w", err)
		}
	}

	dynClient, err := dynamic.NewForConfig(config)
	if err != nil {
		return nil, fmt.Errorf("dynamic client: %w", err)
	}

	return dynClient, nil
}
