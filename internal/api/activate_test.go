package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// Start on a scheduled test means start now: Activate must drop spec.startAt
// in the same patch that lifts the suspension, or the spec keeps a schedule
// the test no longer follows (and the SPA keeps counting down to it).
func TestActivateLoadTestStartsNow(t *testing.T) {
	gin.SetMode(gin.TestMode)
	cases := []struct {
		name, phase string
		scheduled   bool
	}{
		{"scheduled draft at Pending", "Pending", true},
		{"scheduled draft not yet parked", "", true},
		{"plain draft at Pending", "Pending", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			lt := loadTestObj("lt-demo", "env-demo", tc.phase, true)
			if tc.scheduled {
				if err := unstructured.SetNestedField(lt.Object, "2999-01-01T00:00:00Z", "spec", "startAt"); err != nil {
					t.Fatal(err)
				}
			}
			h := guardHandler(lt)
			r := gin.New()
			r.POST("/loadtests/:namespace/:name/activate", h.ActivateLoadTest)
			w := httptest.NewRecorder()
			r.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/loadtests/default/lt-demo/activate", nil))
			if w.Code != http.StatusAccepted {
				t.Fatalf("status = %d, want 202; body %s", w.Code, w.Body.String())
			}

			got, err := h.client.Resource(LoadTestGVR).Namespace("default").Get(context.Background(), "lt-demo", metav1.GetOptions{})
			if err != nil {
				t.Fatal(err)
			}
			if s, _, _ := unstructured.NestedBool(got.Object, "spec", "suspended"); s {
				t.Errorf("spec.suspended still true after Activate")
			}
			if at, found, _ := unstructured.NestedFieldNoCopy(got.Object, "spec", "startAt"); found && at != nil {
				t.Errorf("spec.startAt = %v after Activate, want it dropped", at)
			}
		})
	}
}
