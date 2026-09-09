package api

import (
	"fmt"
	"net/http"
)

// LoadTestIntent is a submitted LoadTest reduced to what the admission rules
// read. Both create paths build one: the JSON handler from CreateLoadTestRequest,
// the YAML importer from the decoded document.
//
// Scheduled is presence, not a value: no rule inspects the instant itself, and
// the YAML path cannot produce a reliable time.Time (yaml.v3 resolves an
// unquoted RFC3339 scalar to time.Time and a quoted one to string), so asking
// it for one would only add a parse that nothing consumes.
type LoadTestIntent struct {
	TargetEnvironment string
	Suspended         bool
	Scheduled         bool
}

// AdmitLoadTest answers the one question both create paths ask: may this
// LoadTest be created against an Environment in this Phase? It returns the HTTP
// status and message the caller must send, or ok.
//
// Two rules, previously re-typed per path — and the first one was missing from
// the YAML path entirely, so an imported document with spec.startAt and no
// spec.suspended reached the operator, which ignores startAt unless suspended
// is set and dispatched the test immediately against a non-dispatchable
// Environment.
//
// The startAt rule now runs after the Environment read rather than before it,
// so a submission that breaks both rules at once reports the missing
// Environment first. Still no cluster write happens before either verdict.
func AdmitLoadTest(intent LoadTestIntent, envPhase string) (status int, msg string, ok bool) {
	if intent.Scheduled && !intent.Suspended {
		return http.StatusBadRequest, "startAt requires suspended=true", false
	}

	// A draft or a scheduled test skips the gate: it runs later, once the
	// Environment settles.
	if !intent.Suspended && !intent.Scheduled && !dispatchable(envPhase) {
		return http.StatusConflict, fmt.Sprintf(
			"environment '%s' is not dispatchable (current phase: %s; requires Ready or Degraded)",
			intent.TargetEnvironment, envPhase), false
	}

	return 0, "", true
}

// dispatchable mirrors the operator's dispatch gate: it dispatches against
// Ready or Degraded, so the gateway must not be stricter. Degraded means the
// monitoring stack is down, which can only fail the metrics export.
func dispatchable(envPhase string) bool {
	return envPhase == "Ready" || envPhase == "Degraded"
}
