package api

import "time"

// --- Environment DTOs ---
// Mirror the dfaas-operator Environment CRD (dfaas.dfaas.io/v1).

// EnvironmentSummary is returned by GET /api/environments.
type EnvironmentSummary struct {
	Name              string    `json:"name"`
	Namespace         string    `json:"namespace"`
	Phase             string    `json:"phase"`
	Message           string    `json:"message,omitempty"`
	CreationTimestamp time.Time `json:"creationTimestamp"`
	NodeCount         int       `json:"nodeCount"`
	K6NodeCount       int       `json:"k6NodeCount"`
	DfaasNodeCount    int       `json:"dfaasNodeCount"`
}

// EnvironmentDetail is returned by GET /api/environments/:namespace/:name.
type EnvironmentDetail struct {
	Name              string          `json:"name"`
	Namespace         string          `json:"namespace"`
	Phase             string          `json:"phase"`
	Message           string          `json:"message,omitempty"`
	CreationTimestamp time.Time       `json:"creationTimestamp"`
	Conditions        []ConditionInfo `json:"conditions,omitempty"`
	Nodes             []NodeInfo      `json:"nodes"`
	Topology          TopologyInfo    `json:"topology"`
	CleanupOnDelete   bool            `json:"cleanupOnDelete"`
	K6Nodes           []K6NodeStatus  `json:"k6Nodes,omitempty"`
	DfaasNodes        []string        `json:"dfaasNodes,omitempty"`
}

// ConditionInfo mirrors metav1.Condition.
type ConditionInfo struct {
	Type               string `json:"type"`
	Status             string `json:"status"`
	Reason             string `json:"reason"`
	Message            string `json:"message"`
	LastTransitionTime string `json:"lastTransitionTime"`
}

// NodeInfo represents one entry in Environment.spec.nodes[].
// Role is "dfaas-worker" or "k6-load-generator" (kebab-case per the operator).
type NodeInfo struct {
	NodeID            string         `json:"nodeID"`
	IpAddress         string         `json:"ipAddress"`
	Role              string         `json:"role"`
	Username          string         `json:"username"`
	Password          string         `json:"password"`
	PrivateKey        string         `json:"privateKey,omitempty"`
	Capacity          string         `json:"capacity"`
	BalancingStrategy string         `json:"balancingStrategy,omitempty"`
	Functions         []FunctionInfo `json:"functions,omitempty"`
}

// FunctionInfo mirrors a dfaas function deployed on a worker.
type FunctionInfo struct {
	Name        string `json:"name"`
	Image       string `json:"image"`
	ExecTimeout int    `json:"execTimeout"`
	MaxInflight int    `json:"maxInflight"`
	TimeoutMs   int    `json:"timeoutMs"`
	MaxRate     int    `json:"maxRate,omitempty"`
}

// TopologyInfo mirrors Environment.spec.topology.
type TopologyInfo struct {
	Links []LinkInfo `json:"links"`
}

// LinkInfo mirrors a topology link with optional latency.
type LinkInfo struct {
	NodeA     string `json:"nodeA"`
	NodeB     string `json:"nodeB"`
	LatencyMs int    `json:"latencyMs"`
}

// K6NodeStatus mirrors Environment.status.k6Nodes[] entries.
type K6NodeStatus struct {
	NodeID           string `json:"nodeID"`
	IPAddress        string `json:"ipAddress"`
	KubeconfigSecret string `json:"kubeconfigSecret"`
}

// CreateEnvironmentRequest is the body for POST /api/environments.
type CreateEnvironmentRequest struct {
	Namespace       string       `json:"namespace" binding:"required"`
	Name            string       `json:"name" binding:"required"`
	Nodes           []NodeInfo   `json:"nodes" binding:"required,min=1"`
	Topology        TopologyInfo `json:"topology"`
	CleanupOnDelete bool         `json:"cleanupOnDelete"`
}

// --- LoadTest DTOs ---
// Mirror the dfaas-operator LoadTest CRD (dfaas.dfaas.io/v1).

// LoadTestSummary is returned by GET /api/loadtests.
type LoadTestSummary struct {
	Name              string     `json:"name"`
	Namespace         string     `json:"namespace"`
	TargetEnvironment string     `json:"targetEnvironment"`
	Phase             string     `json:"phase"`
	Message           string     `json:"message,omitempty"`
	StartTime         *time.Time `json:"startTime,omitempty"`
	EndTime           *time.Time `json:"endTime,omitempty"`
	CreationTimestamp time.Time  `json:"creationTimestamp"`
}

// LoadTestDetail is returned by GET /api/loadtests/:namespace/:name.
type LoadTestDetail struct {
	LoadTestSummary
	PerNodeLoad   []PerNodeLoadView `json:"perNodeLoad"`
	MetricsExport MetricsExportView `json:"metricsExport"`
	TestRuns      []TestRunRefView  `json:"testRuns,omitempty"`
	ExporterJob   string            `json:"exporterJob,omitempty"`
	Conditions    []ConditionInfo   `json:"conditions,omitempty"`
}

// PerNodeLoadView mirrors LoadTest.spec.perNodeLoad[] + carries the materialized script.
type PerNodeLoadView struct {
	NodeID          string `json:"nodeID"`
	VUs             int    `json:"vus"`
	Duration        string `json:"duration"`
	ScriptConfigMap string `json:"scriptConfigMap"`
	Script          string `json:"script,omitempty"`
}

// MetricsExportView mirrors LoadTest.spec.metricsExport.
type MetricsExportView struct {
	Queries     []string               `json:"queries"`
	Step        string                 `json:"step,omitempty"`
	GoogleDrive *GoogleDriveConfigView `json:"googleDrive,omitempty"`
}

// GoogleDriveConfigView mirrors LoadTest.spec.metricsExport.googleDrive.
type GoogleDriveConfigView struct {
	FolderID             string `json:"folderId"`
	CredentialsSecretRef string `json:"credentialsSecretRef"`
}

// TestRunRefView mirrors LoadTest.status.testRuns[].
type TestRunRefView struct {
	NodeID    string `json:"nodeID"`
	Name      string `json:"name"`
	Namespace string `json:"namespace"`
	Phase     string `json:"phase,omitempty"`
}

// CreateLoadTestRequest is the body for POST /api/loadtests.
type CreateLoadTestRequest struct {
	Namespace         string              `json:"namespace" binding:"required"`
	Name              string              `json:"name,omitempty"`
	TargetEnvironment string              `json:"targetEnvironment" binding:"required"`
	PerNodeLoad       []CreatePerNodeLoad `json:"perNodeLoad" binding:"required,min=1"`
	MetricsExport     CreateMetricsExport `json:"metricsExport"`
}

// CreatePerNodeLoad: exactly one of Script or ScriptConfigMap must be set.
type CreatePerNodeLoad struct {
	NodeID          string `json:"nodeID" binding:"required"`
	VUs             int    `json:"vus" binding:"required,min=1"`
	Duration        string `json:"duration" binding:"required"`
	Script          string `json:"script,omitempty"`
	ScriptConfigMap string `json:"scriptConfigMap,omitempty"`
}

// CreateMetricsExport: server defaults Step to "15s" when empty.
type CreateMetricsExport struct {
	Queries     []string                 `json:"queries" binding:"required,min=1"`
	Step        string                   `json:"step,omitempty"`
	GoogleDrive *CreateGoogleDriveConfig `json:"googleDrive,omitempty"`
}

// CreateGoogleDriveConfig: both fields required when present.
type CreateGoogleDriveConfig struct {
	FolderID             string `json:"folderId" binding:"required"`
	CredentialsSecretRef string `json:"credentialsSecretRef" binding:"required"`
}
