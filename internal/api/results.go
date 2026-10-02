package api

import (
	"context"
	"fmt"
	"net"
	"strings"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/validation"
)

// seaweedfsFilerNodePort is the NodePort of the SeaweedFS filer web UI
// (object browser). Distinct from the S3 API NodePort (30900): the filer UI
// lists directories in a browser with no credentials, which is what the
// results links point at.
const seaweedfsFilerNodePort = "30901"

// clusterInternalSuffixes are DNS suffixes that only resolve inside a cluster.
// A proxy that rewrites Host to its upstream Service sends one of them, and a
// link built on it would open nowhere in the user's browser.
var clusterInternalSuffixes = []string{".svc", ".svc.cluster.local", ".cluster.local"}

// browserHost extracts, from the Host header of the request, the host the
// browser opened the UI on, when that host can also serve the filer NodePort.
// The chart exposes the UI on a NodePort of the management node, so the same
// host answers on 30901, and it is by construction an address the browser can
// reach: unlike a node IP read off .status.addresses, which on a multi-site lab
// is often a bridge address nobody outside the node routes to. That reasoning
// needs the gateway in a Pod of the management cluster, so FilerBase consults
// this only when InCluster: a gateway run locally answers on the addresses of
// the machine it runs on, which serve no filer.
//
// The second result is false when the header names no usable host: empty, a
// loopback or unspecified IP, "localhost" (the Vite dev proxy and kubectl
// port-forward both send it), a cluster-internal name, a name whose last label
// is numeric (a browser reads "127.1" as an IPv4 address) or anything that is
// not a DNS-1123 subdomain. A port is optional and discarded, numeric or not.
// An IP comes back in canonical form, so an IPv4-mapped IPv6 address is unmapped.
//
// X-Forwarded-Host is deliberately not read: the gateway trusts no proxy and
// has no authentication, and ingress controllers keep Host by default.
func browserHost(hostHeader string) (string, bool) {
	h := strings.TrimSpace(hostHeader)
	if h == "" {
		return "", false
	}
	host, _, err := net.SplitHostPort(h)
	if err != nil {
		// No port: "dfaas.local" behind an Ingress on :80/:443, or a bracketed
		// "[2001:db8::1]". An unbracketed IPv6 address still fails here.
		if host, _, err = net.SplitHostPort(h + ":0"); err != nil {
			return "", false
		}
	}
	if host == "" {
		return "", false
	}

	// Before the name rules: IsDNS1123Subdomain accepts "127.0.0.1".
	if ip := net.ParseIP(host); ip != nil {
		if ip.IsLoopback() || ip.IsUnspecified() {
			return "", false
		}
		return ip.String(), true
	}

	name := strings.ToLower(strings.TrimSuffix(host, "."))
	if name == "localhost" || strings.HasSuffix(name, ".localhost") {
		return "", false
	}
	for _, suffix := range clusterInternalSuffixes {
		if strings.HasSuffix(name, suffix) {
			return "", false
		}
	}
	labels := strings.Split(name, ".")
	if last := labels[len(labels)-1]; last != "" && strings.Trim(last, "0123456789") == "" {
		return "", false
	}
	if len(validation.IsDNS1123Subdomain(name)) > 0 {
		return "", false
	}
	return name, true
}

// filerHost is browserHost gated on InCluster, so FilerNeedsNodeIP and
// FilerBase cannot disagree on when the request's Host stands in for a node.
func (a assetAddressing) filerHost(requestHost string) (string, bool) {
	if !a.InCluster {
		return "", false
	}
	return browserHost(requestHost)
}

// FilerNeedsNodeIP reports whether the result links have to fall back to a
// cluster node address: neither SEAWEEDFS_FILER_PUBLIC_URL nor the request's
// Host gives a usable base. Nodes are listed only then.
func (a assetAddressing) FilerNeedsNodeIP(requestHost string) bool {
	if a.FilerOverride != "" {
		return false
	}
	_, ok := a.filerHost(requestHost)
	return !ok
}

// FilerBase is the base URL of the result links the browser opens:
//
//   - SEAWEEDFS_FILER_PUBLIC_URL set    → the override, always wins.
//   - in-cluster, a usable request Host → http://<that host>:30901
//   - else a node IP                    → http://<nodeIP>:30901
//   - else                              → "" (no results section)
//
// Outside the cluster (go run against a lab kubeconfig) the Host names the
// machine running the gateway, which serves no filer, so the links fall back
// to the node IP: the address that gateway dials SeaweedFS on (ConnectEndpoint).
//
// nodeIP is resolved by the caller only when FilerNeedsNodeIP says so.
func (a assetAddressing) FilerBase(requestHost, nodeIP string) string {
	if a.FilerOverride != "" {
		return a.FilerOverride
	}
	if host, ok := a.filerHost(requestHost); ok {
		return "http://" + net.JoinHostPort(host, seaweedfsFilerNodePort)
	}
	if nodeIP != "" {
		return "http://" + net.JoinHostPort(nodeIP, seaweedfsFilerNodePort)
	}
	return ""
}

// resolveResultsURLs builds the browsable SeaweedFS filer URLs of a finished
// LoadTest's artifacts (metrics CSVs and k6 logs/summaries). Only the
// per-LoadTest directories are deterministic — object keys embed an export
// timestamp — so the links point at directory listings in the filer UI.
//
// requestHost is the Host header of the browser's request; the base precedence
// is in assetAddressing.FilerBase.
//
// Returns nil when the Environment exports to an external S3 config (no filer
// to browse) or when no public base URL can be derived.
func (h *Handler) resolveResultsURLs(ctx context.Context, envNamespace, envName, ltName, requestHost string) *LoadTestResults {
	env, err := h.client.Resource(EnvironmentGVR).Namespace(envNamespace).Get(ctx, envName, metav1.GetOptions{})
	if err != nil {
		return nil
	}
	if ref := getNestedString(env.Object, "spec", "s3ConfigRef", "name"); ref != "" && !isDefaultS3Config(ref) {
		// External S3: artifacts live outside the in-cluster SeaweedFS.
		return nil
	}

	var nodeIP string
	if h.addressing.FilerNeedsNodeIP(requestHost) {
		// Best-effort surface: no links beats broken links, so a failed lookup
		// and an address-less cluster are both simply "no results section".
		ip, err := h.firstNodeIP(ctx)
		if err != nil || ip == "" {
			return nil
		}
		nodeIP = ip
	}
	base := h.addressing.FilerBase(requestHost, nodeIP)
	if base == "" {
		return nil
	}

	bucket := bucketNameFor(envName, string(env.GetUID()))
	return &LoadTestResults{
		MetricsURL: fmt.Sprintf("%s/buckets/%s/metrics/%s/", base, bucket, ltName),
		K6URL:      fmt.Sprintf("%s/buckets/%s/k6/%s/", base, bucket, ltName),
	}
}
