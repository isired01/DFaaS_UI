package api

import "time"

// --- Response DTOs ---
// Queste strutture mappano 1:1 i campi della CRD Esperimento
// definita in dfaas-operator/api/v1/esperimento_types.go

// ExperimentSummary è la risposta per GET /api/experiments (lista).
type ExperimentSummary struct {
	Name              string    `json:"name"`
	Namespace         string    `json:"namespace"`
	Phase             string    `json:"phase"`
	Message           string    `json:"message,omitempty"`
	CreationTimestamp time.Time `json:"creationTimestamp"`
	NodeCount         int       `json:"nodeCount"`
}

// ExperimentDetail è la risposta per GET /api/experiments/:namespace/:name.
type ExperimentDetail struct {
	Name              string           `json:"name"`
	Namespace         string           `json:"namespace"`
	Phase             string           `json:"phase"`
	Message           string           `json:"message,omitempty"`
	CreationTimestamp time.Time        `json:"creationTimestamp"`
	Conditions        []ConditionInfo  `json:"conditions,omitempty"`
	Federation        FederationInfo   `json:"federation"`
	Topology          TopologyInfo     `json:"topology"`
	IsCleanupRequested bool            `json:"isCleanupRequested"`
}

// ConditionInfo mappa metav1.Condition.
type ConditionInfo struct {
	Type               string `json:"type"`
	Status             string `json:"status"`
	Reason             string `json:"reason"`
	Message            string `json:"message"`
	LastTransitionTime string `json:"lastTransitionTime"`
}

// FederationInfo mappa spec.federation.
type FederationInfo struct {
	Nodes []NodeInfo `json:"nodes"`
}

// NodeInfo mappa un singolo nodo della federazione.
// Include TUTTI i campi come richiesto dall'utente.
type NodeInfo struct {
	NodeID            string        `json:"nodeID"`
	IpAddress         string        `json:"ipAddress"`
	Username          string        `json:"username"`
	Password          string        `json:"password"`
	PrivateKey        string        `json:"privateKey"`
	Capacity          string        `json:"capacity"`
	BalancingStrategy string        `json:"balancingStrategy"`
	Functions         []FunctionInfo `json:"functions,omitempty"`
}

// FunctionInfo mappa una funzione OpenFaaS deployata su un nodo.
type FunctionInfo struct {
	Name        string `json:"name"`
	Image       string `json:"image"`
	ExecTimeout int    `json:"execTimeout"`
	MaxInflight int    `json:"maxInflight"`
	TimeoutMs   int    `json:"timeoutMs"`
}

// TopologyInfo mappa spec.topology.
type TopologyInfo struct {
	Links []LinkInfo `json:"links"`
}

// LinkInfo mappa un link di rete tra due nodi.
type LinkInfo struct {
	NodeA     string `json:"nodeA"`
	NodeB     string `json:"nodeB"`
	LatencyMs int    `json:"latencyMs"`
}

// --- Request DTOs ---

// K6GenerateRequest è il body per POST /api/k6/generate.
type K6GenerateRequest struct {
	Scenarios      []K6Scenario `json:"scenarios" binding:"required"`
	MetricsQueries string       `json:"metricsQueries,omitempty"`
}

type K6Scenario struct {
	Name            string    `json:"name"`
	Executor        string    `json:"executor"`
	Method          string    `json:"method"`
	TargetURL       string    `json:"targetURL"`
	StartTime       string    `json:"startTime"`
	PreAllocatedVUs int       `json:"preAllocatedVUs"`
	MaxVUs          int       `json:"maxVUs"`
	Body            string    `json:"body"`
	Headers         string    `json:"headers"` // JSON string
	Stages          []K6Stage `json:"stages"`
}

type K6Stage struct {
	Duration string `json:"duration"`
	Target   int    `json:"target"`
}

// K6GenerateResponse è la risposta con il template YAML generato.
type K6GenerateResponse struct {
	Script string `json:"script"`
	YAML   string `json:"yaml"`
}
