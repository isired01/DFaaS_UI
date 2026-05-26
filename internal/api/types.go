package api

import "time"

// --- Environment DTOs ---
// Mirror the dfaas-operator Environment CRD (dfaas.dfaas.io/v1).

// EnvironmentSummary is returned by GET /api/environments.
type EnvironmentSummary struct {
	Name               string    `json:"name"`
	Namespace          string    `json:"namespace"`
	Phase              string    `json:"phase"`
	Message            string    `json:"message,omitempty"`
	CreationTimestamp  time.Time `json:"creationTimestamp"`
	Generation         int64     `json:"generation"`
	ObservedGeneration int64     `json:"observedGeneration"`
	NodeCount          int       `json:"nodeCount"`
	K6NodeCount        int       `json:"k6NodeCount"`
	DfaasNodeCount     int       `json:"dfaasNodeCount"`
}

// EnvironmentDetail is returned by GET /api/environments/:namespace/:name.
type EnvironmentDetail struct {
	Name               string           `json:"name"`
	Namespace          string           `json:"namespace"`
	Phase              string           `json:"phase"`
	Message            string           `json:"message,omitempty"`
	CreationTimestamp  time.Time        `json:"creationTimestamp"`
	Generation         int64            `json:"generation"`
	ObservedGeneration int64            `json:"observedGeneration"`
	Conditions         []ConditionInfo  `json:"conditions,omitempty"`
	Nodes              []NodeInfo       `json:"nodes"`
	Topology           TopologyInfo     `json:"topology"`
	CleanupOnDelete    bool             `json:"cleanupOnDelete"`
	K6Nodes            []K6NodeStatus   `json:"k6Nodes,omitempty"`
	DfaasNodes         []string         `json:"dfaasNodes,omitempty"`
	S3ConfigRef        *S3ConfigRefView `json:"s3ConfigRef,omitempty"`
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
	Namespace       string           `json:"namespace" binding:"required"`
	Name            string           `json:"name" binding:"required"`
	Nodes           []NodeInfo       `json:"nodes" binding:"required,min=1"`
	Topology        TopologyInfo     `json:"topology"`
	CleanupOnDelete bool             `json:"cleanupOnDelete"`
	S3ConfigRef     *S3ConfigRefView `json:"s3ConfigRef,omitempty"`
}

// UpdateEnvironmentRequest is the body for PATCH /api/environments/:ns/:name.
// Mirrors the merge-patch shape Kubernetes expects: { "spec": { ... } }.
// Pointer/omitempty on each spec field means "absent in the patch" rather than
// "set to zero value".
type UpdateEnvironmentRequest struct {
	Spec UpdateEnvironmentSpec `json:"spec" binding:"required"`
}

// UpdateEnvironmentSpec carries the subset of Environment.spec the client wants
// to merge-patch. Any field left nil/omitted is preserved on the cluster object.
type UpdateEnvironmentSpec struct {
	CleanupOnDelete *bool            `json:"cleanupOnDelete,omitempty"`
	Nodes           []NodeInfo       `json:"nodes,omitempty"`
	Topology        *TopologyInfo    `json:"topology,omitempty"`
	S3ConfigRef     *S3ConfigRefView `json:"s3ConfigRef,omitempty"`
}

// --- LoadTest DTOs ---
// Mirror the dfaas-operator LoadTest CRD (dfaas.dfaas.io/v1).

// LoadTestSummary is returned by GET /api/loadtests.
type LoadTestSummary struct {
	Name              string     `json:"name"`
	Namespace         string     `json:"namespace"`
	TargetEnvironment string     `json:"targetEnvironment"`
	Phase             string     `json:"phase"`
	Suspended         bool       `json:"suspended,omitempty"`
	StartAt           *time.Time `json:"startAt,omitempty"`
	Stop              bool       `json:"stop,omitempty"`
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
// S3 export is configured per-Environment via spec.s3ConfigRef (see EnvironmentDetail);
// LoadTest no longer carries any export-destination fields.
type MetricsExportView struct {
	Metrics []MetricEntryView `json:"metrics"`
	Step    string            `json:"step,omitempty"`
}

// MetricEntryView mirrors LoadTest.spec.metricsExport.metrics[].
// Type is "raw" or "custom-promql". MetricName is optional for raw entries
// (operator falls back to query) and required for custom-promql.
type MetricEntryView struct {
	Type       string `json:"type"`
	MetricName string `json:"metricName,omitempty"`
	Query      string `json:"query"`
	Comment    string `json:"comment,omitempty"`
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
	Suspended         bool                `json:"suspended,omitempty"`
	StartAt           *time.Time          `json:"startAt,omitempty"`
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
// S3 export destination lives on the Environment, not on LoadTest.
type CreateMetricsExport struct {
	Metrics []CreateMetricEntry `json:"metrics" binding:"required,min=1"`
	Step    string              `json:"step,omitempty"`
}

// CreateMetricEntry: each row in metricsExport.metrics.
// Query is always required. MetricName must be non-empty when Type=="custom-promql".
type CreateMetricEntry struct {
	Type       string `json:"type" binding:"required,oneof=raw custom-promql"`
	MetricName string `json:"metricName,omitempty"`
	Query      string `json:"query" binding:"required,min=1"`
	Comment    string `json:"comment,omitempty"`
}

// --- S3 server-config DTOs ---
// One Secret per config lives in the cluster-scoped registry namespace
// `dfaas-s3`, labeled `dfaas.io/s3-config=true`. The Environment references
// a config by name via `spec.s3ConfigRef.name`.

// S3ConfigRefView is the pointer carried on Environment.spec.s3ConfigRef.
type S3ConfigRefView struct {
	Name string `json:"name"`
}

// S3ConfigSummary is returned by GET /api/s3-configs (list).
// Key fields are never returned; the underlying Secret holds them.
type S3ConfigSummary struct {
	Name      string    `json:"name"`
	Endpoint  string    `json:"endpoint"`
	Region    string    `json:"region"`
	CreatedAt time.Time `json:"createdAt"`
}

// S3ConfigDetail is returned by GET /api/s3-configs/:name.
// Same redaction rule applies: access/secret keys are never echoed.
type S3ConfigDetail struct {
	S3ConfigSummary
	ForcePathStyle bool `json:"forcePathStyle"`
}

// CreateS3Config is the body for POST /api/s3-configs.
// Name must be DNS-1123 (validated explicitly in the handler on top of the
// binding tags below — the validator only enforces length here).
type CreateS3Config struct {
	Name            string `json:"name"            binding:"required,min=1,max=63"`
	Endpoint        string `json:"endpoint"`
	Region          string `json:"region"          binding:"required,min=1"`
	AccessKeyId     string `json:"accessKeyId"     binding:"required,min=1"`
	SecretAccessKey string `json:"secretAccessKey" binding:"required,min=1"`
	ForcePathStyle  bool   `json:"forcePathStyle"`
}
