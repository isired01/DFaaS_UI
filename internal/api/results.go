package api

import (
	"context"
	"fmt"
	"os"
	"strings"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// seaweedfsFilerNodePort is the NodePort of the SeaweedFS filer web UI
// (object browser). Distinct from the S3 API NodePort (30900): the filer UI
// lists directories in a browser with no credentials, which is what the
// results links point at.
const seaweedfsFilerNodePort = "30901"

// resolveResultsURLs builds the browsable SeaweedFS filer URLs of a finished
// LoadTest's artifacts (metrics CSVs and k6 logs/summaries). Only the
// per-LoadTest directories are deterministic — object keys embed an export
// timestamp — so the links point at directory listings in the filer UI.
//
// Returns nil when the Environment exports to an external S3 config (no filer
// to browse) or when no public base URL can be derived.
func (h *Handler) resolveResultsURLs(ctx context.Context, envNamespace, envName, ltName string) *LoadTestResults {
	env, err := h.client.Resource(EnvironmentGVR).Namespace(envNamespace).Get(ctx, envName, metav1.GetOptions{})
	if err != nil {
		return nil
	}
	if ref := getNestedString(env.Object, "spec", "s3ConfigRef", "name"); ref != "" && ref != DefaultS3ConfigName {
		// External S3: artifacts live outside the in-cluster SeaweedFS.
		return nil
	}

	// SEAWEEDFS_FILER_PUBLIC_URL override → else <first node IP>:30901.
	base := strings.TrimRight(os.Getenv("SEAWEEDFS_FILER_PUBLIC_URL"), "/")
	if base == "" {
		// Best-effort surface: no links beats broken links, so a failed lookup
		// and an address-less cluster are both simply "no results section".
		ip, err := h.firstNodeIP(ctx)
		if err != nil || ip == "" {
			return nil
		}
		base = fmt.Sprintf("http://%s:%s", ip, seaweedfsFilerNodePort)
	}

	bucket := bucketNameFor(envName, string(env.GetUID()))
	return &LoadTestResults{
		MetricsURL: fmt.Sprintf("%s/buckets/%s/metrics/%s/", base, bucket, ltName),
		K6URL:      fmt.Sprintf("%s/buckets/%s/k6/%s/", base, bucket, ltName),
	}
}
