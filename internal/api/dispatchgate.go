package api

import (
	"fmt"
	"net/http"
)

// LoadTestIntent is a submitted LoadTest reduced to what the admission rules
// read. Both create paths build one: the JSON handler from CreateLoadTestRequest,
// the YAML importer from the decoded document.
//
// Scheduled is presence, not a value: no rule inspects the instant itself.
type LoadTestIntent struct {
	TargetEnvironment string
	Suspended         bool
	Scheduled         bool
}

// AdmitLoadTest answers the one question both create paths ask: may this
// LoadTest be created against an Environment in this Phase? It returns the HTTP
// status and message the caller must send, or ok.
//
// Both create paths reach it through admitAgainstEnvironment after the
// Environment read, so a missing Environment is reported first; no cluster
// write happens before either verdict. The operator fails the same
// startAt-without-suspended object at admission (a kubectl apply).
func AdmitLoadTest(intent LoadTestIntent, envPhase string) (status int, msg string, ok bool) {
	if intent.Scheduled && !intent.Suspended {
		return http.StatusBadRequest, "startAt requires suspended=true", false
	}

	// A draft or a scheduled test skips the gate: it runs later, once the
	// Environment settles.
	if !intent.Suspended && !intent.Scheduled && !dispatchable(envPhase) {
		return http.StatusConflict, fmt.Sprintf(
			"environment '%s' is not dispatchable (current phase: %s; requires Ready)",
			intent.TargetEnvironment, envPhase), false
	}

	return 0, "", true
}

// dispatchable mirrors the operator's dispatch gate (EnvironmentPhase.
// Dispatchable): Ready only. The gateway must be neither stricter nor looser.
func dispatchable(envPhase string) bool {
	return envPhase == "Ready"
}
