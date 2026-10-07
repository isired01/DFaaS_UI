package api

import (
	"net/http"
	"strings"
	"testing"
)

// The YAML import path used to skip the startAt rule entirely, so the cases
// below are the regression: every one of them must hold whichever create path
// built the intent.
func TestAdmitLoadTest(t *testing.T) {
	cases := []struct {
		name       string
		intent     LoadTestIntent
		envPhase   string
		wantStatus int
		wantMsg    string
	}{
		{
			name:       "scheduled without suspended is rejected even against a ready environment",
			intent:     LoadTestIntent{TargetEnvironment: "env-a", Scheduled: true},
			envPhase:   "Ready",
			wantStatus: http.StatusBadRequest,
			wantMsg:    "startAt requires suspended=true",
		},
		{
			name:       "scheduled and suspended skips the dispatch gate",
			intent:     LoadTestIntent{TargetEnvironment: "env-a", Suspended: true, Scheduled: true},
			envPhase:   "ProvisioningInfra",
			wantStatus: 0,
		},
		{
			name:       "a draft skips the dispatch gate",
			intent:     LoadTestIntent{TargetEnvironment: "env-a", Suspended: true},
			envPhase:   "ProvisioningInfra",
			wantStatus: 0,
		},
		{
			name:       "an immediate test needs a dispatchable environment",
			intent:     LoadTestIntent{TargetEnvironment: "env-a"},
			envPhase:   "ProvisioningInfra",
			wantStatus: http.StatusConflict,
			wantMsg:    "not dispatchable",
		},
		{
			name:       "Ready is dispatchable",
			intent:     LoadTestIntent{TargetEnvironment: "env-a"},
			envPhase:   "Ready",
			wantStatus: 0,
		},
		{
			// An Environment that never reconciled has no phase at all.
			name:       "an empty phase is not dispatchable",
			intent:     LoadTestIntent{TargetEnvironment: "env-a"},
			envPhase:   "",
			wantStatus: http.StatusConflict,
			wantMsg:    "not dispatchable",
		},
		{
			// Both rules broken: the startAt verdict wins, because a body that
			// cannot be honoured is worth reporting before the cluster state.
			name:       "the startAt rule outranks the dispatch gate",
			intent:     LoadTestIntent{TargetEnvironment: "env-a", Scheduled: true},
			envPhase:   "ProvisioningInfra",
			wantStatus: http.StatusBadRequest,
			wantMsg:    "startAt requires suspended=true",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			status, msg, ok := AdmitLoadTest(tc.intent, tc.envPhase)

			if tc.wantStatus == 0 {
				if !ok {
					t.Fatalf("want admitted, got status=%d msg=%q", status, msg)
				}
				if status != 0 || msg != "" {
					t.Fatalf("an admitted intent must return no status and no message, got %d %q", status, msg)
				}
				return
			}

			if ok {
				t.Fatalf("want rejected with %d, got admitted", tc.wantStatus)
			}
			if status != tc.wantStatus {
				t.Fatalf("status: want %d, got %d (%q)", tc.wantStatus, status, msg)
			}
			if !strings.Contains(msg, tc.wantMsg) {
				t.Fatalf("message %q does not contain %q", msg, tc.wantMsg)
			}
		})
	}
}

// The gateway must match the operator, which dispatches against Ready only.
// Degraded and Idle are listed on the negative side on purpose: both phases
// were removed from the CRD, and an object still carrying one must not be
// dispatched.
func TestDispatchablePhases(t *testing.T) {
	if !dispatchable("Ready") {
		t.Error("Ready must be dispatchable")
	}
	for _, p := range []string{"", "ProvisioningVMs", "ProvisioningInfra", "ProvisioningMonitoring", "Unreachable", "Failed", "Degraded", "Idle"} {
		if dispatchable(p) {
			t.Errorf("%s must not be dispatchable", p)
		}
	}
}
