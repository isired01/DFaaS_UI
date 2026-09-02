package api

import (
	"fmt"
	"log"
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

// SecretGVR is the GVR for core/v1 Secrets, used to store S3 server configs
// in the cluster-scoped registry namespace.
var SecretGVR = schema.GroupVersionResource{
	Group:    "",
	Version:  "v1",
	Resource: "secrets",
}

// S3ConfigNamespace is the cluster-scoped registry namespace for S3 server configs.
const S3ConfigNamespace = "dfaas-s3"

// S3ConfigLabel is the label set on every Secret managed by the S3-config tab.
// Value is always "true" — used as a selector by list/cleanup queries.
const S3ConfigLabel = "dfaas.io/s3-config"

// NewK8sClient builds a dynamic Kubernetes client.
// In-cluster config first, then KUBECONFIG env, then ~/.kube/config.
func NewK8sClient() (dynamic.Interface, error) {
	config, err := rest.InClusterConfig()
	if err != nil {
		kubeconfig := os.Getenv("KUBECONFIG")
		if kubeconfig == "" {
			home, herr := os.UserHomeDir()
			if herr != nil {
				// Not fatal on its own — BuildConfigFromFlags below reports the
				// resulting bad path — but the cause belongs in the log.
				log.Printf("resolve home directory for the default kubeconfig path: %v", herr)
			}
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
