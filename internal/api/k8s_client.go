package api

import (
	"fmt"
	"os"
	"path/filepath"

	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

// EsperimentoGVR è il GroupVersionResource della CRD Esperimento.
// Usato dal dynamic client per interagire con risorse non tipizzate.
var EsperimentoGVR = schema.GroupVersionResource{
	Group:    "dfaas.dfaas.io",
	Version:  "v1",
	Resource: "esperimentos",
}

// NewK8sClient crea un client dinamico Kubernetes.
// Prova prima la configurazione in-cluster (quando gira dentro un pod),
// poi fallback su KUBECONFIG (per sviluppo locale).
func NewK8sClient() (dynamic.Interface, error) {
	// 1. Prova in-cluster config
	config, err := rest.InClusterConfig()
	if err != nil {
		// 2. Fallback su KUBECONFIG
		kubeconfig := os.Getenv("KUBECONFIG")
		if kubeconfig == "" {
			home, _ := os.UserHomeDir()
			kubeconfig = filepath.Join(home, ".kube", "config")
		}

		config, err = clientcmd.BuildConfigFromFlags("", kubeconfig)
		if err != nil {
			return nil, fmt.Errorf("impossibile creare config Kubernetes: %w", err)
		}
	}

	// 3. Crea il dynamic client
	dynClient, err := dynamic.NewForConfig(config)
	if err != nil {
		return nil, fmt.Errorf("impossibile creare dynamic client: %w", err)
	}

	return dynClient, nil
}
