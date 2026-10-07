package api

import "time"

// --- Environment DTOs ---
// Mirror the dfaas-operator Environment CRD (dfaas.dfaas.io/v1).

// EnvironmentSummary is returned by GET /api/environments.
//
// There is no message field: the CRDs have no status.message. All messaging goes
// through the Ready condition, surfaced in Conditions.
type EnvironmentSummary struct {
	Name               string    `json:"name"`
	Namespace          string    `json:"namespace"`
	Phase              string    `json:"phase"`
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
	CreationTimestamp  time.Time        `json:"creationTimestamp"`
	Generation         int64            `json:"generation"`
	ObservedGeneration int64            `json:"observedGeneration"`
	LastHealthCheck    string           `json:"lastHealthCheck,omitempty"`
	Conditions         []ConditionInfo  `json:"conditions,omitempty"`
	Nodes              []NodeInfo       `json:"nodes"`
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

// FunctionInfo mirrors a dfaas function deployed on a worker. The numeric
// tuning fields carry omitempty: a value of 0 is never valid for them, so a
// blank form field (0) is dropped from the outgoing patch/create body and the
// CRD's defaulting applies instead of an explicit 0 (which the CRD's Minimum=1 rejects).
type FunctionInfo struct {
	Name        string `json:"name"`
	Image       string `json:"image"`
	ExecTimeout int    `json:"execTimeout,omitempty"`
	MaxInflight int    `json:"maxInflight,omitempty"`
	TimeoutMs   int    `json:"timeoutMs,omitempty"`
	MaxRate     int    `json:"maxRate,omitempty"`
}

// K6NodeStatus mirrors Environment.status.k6Nodes[] entries.
type K6NodeStatus struct {
	NodeID           string `json:"nodeID"`
	IPAddress        string `json:"ipAddress"`
	KubeconfigSecret string `json:"kubeconfigSecret"`
	// ManagementAddress is the management node's address as this generator
	// sees it, detected and verified by the operator at provisioning; the
	// operator builds on it every URL this generator's runners dial back.
	// Empty when none was recorded: an older playbook (an Environment not
	// re-provisioned since the operator upgrade), a generator reached over
	// IPv6 (never recorded: its k3s is single-stack IPv4), or a detection
	// that failed or could not be verified. Display-only here.
	ManagementAddress string `json:"managementAddress,omitempty"`
}

// CreateEnvironmentRequest is the body for POST /api/environments.
type CreateEnvironmentRequest struct {
	Namespace   string           `json:"namespace" binding:"required"`
	Name        string           `json:"name" binding:"required"`
	Nodes       []NodeInfo       `json:"nodes" binding:"required,min=1"`
	S3ConfigRef *S3ConfigRefView `json:"s3ConfigRef,omitempty"`
}

// UpdateEnvironmentRequest is the body for PATCH /api/environments/:ns/:name.
// Mirrors the merge-patch shape Kubernetes expects: { "spec": { ... } }.
// S3ConfigRef uses "absent in the patch" vs "set" semantics: nil is omitted and
// preserved on the cluster object.
type UpdateEnvironmentRequest struct {
	Spec UpdateEnvironmentSpec `json:"spec" binding:"required"`
}

// UpdateEnvironmentSpec carries the subset of Environment.spec the client wants
// to merge-patch. Pointer fields left nil are omitted and preserved on the
// cluster object.
//
// Nodes is a non-pointer slice with standard array-replace semantics: when
// present it replaces the whole list, and an empty array is NOT a valid clear
// (spec.nodes has CRD MinItems=1). It carries no absent-vs-zero distinction.
//
// S3ConfigRef is set-only; to clear it back to the operator default set
// ClearS3ConfigRef=true instead, which patches s3ConfigRef to JSON null (the
// omitempty pointer alone cannot express an explicit null).
type UpdateEnvironmentSpec struct {
	Nodes            []NodeInfo       `json:"nodes,omitempty"`
	S3ConfigRef      *S3ConfigRefView `json:"s3ConfigRef,omitempty"`
	ClearS3ConfigRef bool             `json:"clearS3ConfigRef,omitempty"`
}

// --- LoadTest DTOs ---
// Mirror the dfaas-operator LoadTest CRD (dfaas.dfaas.io/v1).

// LoadTestSummary is returned by GET /api/loadtests.
//
// There is no message field: the CRDs have no status.message. All messaging goes
// through the Ready condition, surfaced in Conditions.
type LoadTestSummary struct {
	Name              string     `json:"name"`
	Namespace         string     `json:"namespace"`
	TargetEnvironment string     `json:"targetEnvironment"`
	Phase             string     `json:"phase"`
	Suspended         bool       `json:"suspended,omitempty"`
	SyncStart         bool       `json:"syncStart"`
	StartAt           *time.Time `json:"startAt,omitempty"`
	Stop              bool       `json:"stop,omitempty"`
	StartTime         *time.Time `json:"startTime,omitempty"`
	EndTime           *time.Time `json:"endTime,omitempty"`
	CreationTimestamp time.Time  `json:"creationTimestamp"`
	// RunnersUnreclaimed: the test ended but a remote runner could not be
	// deleted, so the operator still holds its Environment (mapLoadTestSummary).
	RunnersUnreclaimed bool `json:"runnersUnreclaimed,omitempty"`
}

// LoadTestDetail is returned by GET /api/loadtests/:namespace/:name.
type LoadTestDetail struct {
	LoadTestSummary
	PerNodeLoad   []PerNodeLoadView `json:"perNodeLoad"`
	MetricsExport MetricsExportView `json:"metricsExport"`
	TestRuns      []TestRunRefView  `json:"testRuns,omitempty"`
	ExporterJob   string            `json:"exporterJob,omitempty"`
	Conditions    []ConditionInfo   `json:"conditions,omitempty"`
	// Results carries browsable SeaweedFS filer URLs of the exported
	// artifacts. Set only when the test Completed and the Environment
	// exports to the in-cluster SeaweedFS (results.go).
	Results *LoadTestResults `json:"results,omitempty"`
}

// LoadTestResults are the filer directory listings holding a finished test's
// artifacts (keys embed an export timestamp, so only directories are stable).
type LoadTestResults struct {
	MetricsURL string `json:"metricsUrl"`
	K6URL      string `json:"k6Url"`
}

// UploadAssetResponse is the 201 body of POST /api/loadtests/assets.
type UploadAssetResponse struct {
	// URL is the absolute URL baked at upload time: SEAWEEDFS_PUBLIC_URL,
	// else a node IP, for the in-cluster SeaweedFS; the config's own endpoint
	// otherwise. Always set, and the fallback of a relocatable asset.
	URL         string `json:"url"`
	ContentType string `json:"contentType"`
	Filename    string `json:"filename"`
	// Relocatable is true on the in-cluster SeaweedFS (seaweedfs-default). No
	// omitempty, so the wire always states it; the SPA treats only true as
	// relocatable (payloadPatch), a missing key and false alike.
	Relocatable bool `json:"relocatable"`
	// Path is "/<bucket>/<key>", set only when Relocatable. A runner given
	// DFAAS_ASSET_BASE fetches DFAAS_ASSET_BASE + Path; URL always ends with it.
	Path string `json:"path,omitempty"`
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
	Namespace string `json:"namespace" binding:"required"`
	Name      string `json:"name,omitempty"`
	// NameSuffix is an optional user-supplied suffix appended to the
	// auto-generated name (lt-<env>-<timestamp>[-<suffix>]-<nonce>). Ignored
	// when Name is set (full override). Sanitized to DNS-1123 server-side.
	NameSuffix        string `json:"nameSuffix,omitempty"`
	TargetEnvironment string `json:"targetEnvironment" binding:"required"`
	Suspended         bool   `json:"suspended,omitempty"`
	// SyncStart requests a synchronized start: the operator injects DFAAS_SYNC_URL
	// into every remote k6 runner and holds them at a barrier until every TestRun
	// reports k6-operator's stage started; a few seconds of skew can remain.
	SyncStart     bool                `json:"syncStart"`
	StartAt       *time.Time          `json:"startAt,omitempty"`
	PerNodeLoad   []CreatePerNodeLoad `json:"perNodeLoad" binding:"required,min=1"`
	MetricsExport CreateMetricsExport `json:"metricsExport"`
}

// CreatePerNodeLoad: exactly one of Script or ScriptConfigMap must be set.
// Element rules live in validateLoadTest: binding tags on slice elements are
// never run without `dive`, so they only looked enforced.
type CreatePerNodeLoad struct {
	NodeID          string `json:"nodeID"`
	VUs             int    `json:"vus"`
	Duration        string `json:"duration"`
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
	Type       string `json:"type"`
	MetricName string `json:"metricName,omitempty"`
	Query      string `json:"query"`
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
