package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	k8stesting "k8s.io/client-go/testing"
)

// The result links used to be built on the first node IP of the cluster, which
// on a multi-site lab is often a bridge address the user's browser cannot
// reach, so the links of every finished test opened nowhere. The browser
// already proved it reaches one address: the host it opened the UI on. These
// tests pin which Host headers may stand in for that address, the precedence
// against SEAWEEDFS_FILER_PUBLIC_URL and the node IP, that only an in-cluster
// gateway trusts the Host (a local one is opened on its own machine, which
// serves no filer), and that the node list is not even read when the Host
// suffices. None of this had a test.

func TestBrowserHost(t *testing.T) {
	accept := []struct {
		name, header, want string
	}{
		{"an IPv4 address with the UI NodePort", "192.0.2.10:30800", "192.0.2.10"},
		{"a name with no port, as behind an Ingress", "dfaas.local", "dfaas.local"},
		{"a name is lower-cased and loses its port", "DFAAS.Local:443", "dfaas.local"},
		{"a trailing dot is dropped", "dfaas.lab.", "dfaas.lab"},
		{"a bracketed IPv6 address with a port", "[2001:db8::1]:30800", "2001:db8::1"},
		{"a bracketed IPv6 address with no port", "[2001:db8::1]", "2001:db8::1"},
		{"a tailnet address", "100.64.1.2:30800", "100.64.1.2"},
		{"a single-label name", "mgmt:30800", "mgmt"},
		{"an IPv4-mapped IPv6 address is unmapped", "[::ffff:192.0.2.7]:80", "192.0.2.7"},
		{"a non-numeric port is ignored", "dfaas.lab:abc", "dfaas.lab"},
		{"surrounding space is trimmed", "  192.0.2.10:30800 ", "192.0.2.10"},
	}
	for _, tc := range accept {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := browserHost(tc.header)
			if !ok || got != tc.want {
				t.Errorf("browserHost(%q) = (%q, %v), want (%q, true)", tc.header, got, ok, tc.want)
			}
		})
	}

	reject := []struct {
		name, header string
	}{
		{"an empty header", ""},
		{"a port with no host", ":8082"},
		{"localhost, as the Vite dev proxy sends it", "localhost:8082"},
		{"localhost in capitals", "LOCALHOST"},
		{"localhost with a trailing dot", "localhost.:80"},
		{"a subdomain of localhost", "app.localhost:5173"},
		{"an IPv4 loopback address", "127.0.0.1:5173"},
		{"anywhere in the IPv4 loopback range", "127.1.2.3"},
		{"the IPv6 loopback address", "[::1]:8082"},
		{"an IPv4-mapped loopback address", "[::ffff:127.0.0.1]:80"},
		{"the IPv4 unspecified address", "0.0.0.0:8082"},
		{"the IPv6 unspecified address", "[::]:80"},
		{"an unbracketed IPv6 address", "2001:db8::1"},
		{"an IPv6 address with a zone", "[fe80::1%25eth0]:80"},
		{"a cluster Service name", "dfaas-ui.dfaas-system.svc:8082"},
		{"a fully qualified Service name", "dfaas-ui.dfaas-system.svc.cluster.local:8082"},
		{"a name under cluster.local", "pod.cluster.local"},
		{"a short IPv4 form a browser would read as 127.0.0.1", "127.1:80"},
		{"a name whose last label is numeric", "lab.10:80"},
		{"an underscore", "a_b:80"},
		{"a quote", "a'b:80"},
		{"parentheses", "x(y):80"},
		{"a leading dash", "-bad.lab"},
		{"two trailing dots", "dfaas.lab.."},
	}
	for _, tc := range reject {
		t.Run(tc.name, func(t *testing.T) {
			if got, ok := browserHost(tc.header); ok {
				t.Errorf("browserHost(%q) = (%q, true), want it rejected", tc.header, got)
			}
		})
	}
}

func TestFilerBase(t *testing.T) {
	inCluster := assetAddressing{InCluster: true}
	cases := []struct {
		name          string
		addr          assetAddressing
		host, nodeIP  string
		want          string
		wantNeedsNode bool
	}{
		{
			name: "the override beats a usable host",
			addr: assetAddressing{FilerOverride: "https://files.lab.example", InCluster: true},
			host: "192.0.2.50:30800", nodeIP: "192.0.2.10",
			want: "https://files.lab.example",
		},
		{
			name: "the override needs no host at all",
			addr: assetAddressing{FilerOverride: "https://files.lab.example"},
			host: "localhost:8082",
			want: "https://files.lab.example",
		},
		{
			name: "a usable host beats the node IP",
			addr: inCluster,
			host: "192.0.2.50:30800", nodeIP: "192.0.2.10",
			want: "http://192.0.2.50:" + seaweedfsFilerNodePort,
		},
		{
			name: "an IPv6 host is bracketed",
			addr: inCluster,
			host: "[2001:db8::1]:30800",
			want: "http://[2001:db8::1]:" + seaweedfsFilerNodePort,
		},
		{
			name: "outside the cluster a usable host still falls back to the node IP",
			host: "192.0.2.50:8082", nodeIP: "192.0.2.10",
			want:          "http://192.0.2.10:" + seaweedfsFilerNodePort,
			wantNeedsNode: true,
		},
		{
			name: "a loopback host falls back to the node IP",
			addr: inCluster,
			host: "localhost:8082", nodeIP: "192.0.2.10",
			want:          "http://192.0.2.10:" + seaweedfsFilerNodePort,
			wantNeedsNode: true,
		},
		{
			name: "an IPv6 node IP is bracketed",
			addr: inCluster,
			host: "127.0.0.1:8082", nodeIP: "2001:db8::10",
			want:          "http://[2001:db8::10]:" + seaweedfsFilerNodePort,
			wantNeedsNode: true,
		},
		{
			name:          "nothing usable gives no base",
			addr:          inCluster,
			host:          "localhost:8082",
			want:          "",
			wantNeedsNode: true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.addr.FilerNeedsNodeIP(tc.host); got != tc.wantNeedsNode {
				t.Errorf("FilerNeedsNodeIP(%q) = %v, want %v", tc.host, got, tc.wantNeedsNode)
			}
			if got := tc.addr.FilerBase(tc.host, tc.nodeIP); got != tc.want {
				t.Errorf("FilerBase(%q, %q) = %q, want %q", tc.host, tc.nodeIP, got, tc.want)
			}
		})
	}
}

// SEAWEEDFS_FILER_PUBLIC_URL is read once, with the same trailing-slash rule as
// the other two overrides, instead of on every GetLoadTest.
func TestAddressingFromEnvReadsTheFilerOverride(t *testing.T) {
	t.Setenv("SEAWEEDFS_FILER_PUBLIC_URL", "http://files.lab.example:30901/")
	if got := addressingFromEnv().FilerOverride; got != "http://files.lab.example:30901" {
		t.Errorf("FilerOverride = %q, want the URL with its trailing slash trimmed", got)
	}
}

// resultsHandler is assetHandler for GetLoadTest, and also counts the Node
// lists, so a test can tell that the browser-host branch never read them.
func resultsHandler(addr assetAddressing, objs ...runtime.Object) (*Handler, *int) {
	listKinds := map[schema.GroupVersionResource]string{
		LoadTestGVR:    "LoadTestList",
		EnvironmentGVR: "EnvironmentList",
		NodeGVR:        "NodeList",
	}
	client := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(), listKinds, objs...)
	nodeLists := 0
	client.PrependReactor("list", "nodes", func(k8stesting.Action) (bool, runtime.Object, error) {
		nodeLists++
		return false, nil, nil
	})
	return &Handler{client: client, addressing: addr}, &nodeLists
}

// getLoadTest GETs lt-demo with an explicit Host. httptest.NewRequest
// defaults Host to "example.com", a valid name that would silently take the
// browser-host branch, so every case sets its own.
func getLoadTest(t *testing.T, h *Handler, host string) map[string]json.RawMessage {
	t.Helper()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/loadtests/:namespace/:name", h.GetLoadTest)

	req := httptest.NewRequest(http.MethodGet, "/loadtests/default/lt-demo", nil)
	req.Host = host
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var body map[string]json.RawMessage
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	return body
}

func TestGetLoadTestResultLinks(t *testing.T) {
	const bucketPath = "/buckets/bari-uid-fa"
	inCluster := assetAddressing{InCluster: true}

	cases := []struct {
		name      string
		addr      assetAddressing
		host      string
		phase     string
		s3Config  string
		nodeIP    string
		wantBase  string // "" means no results key at all
		wantLists int
	}{
		{
			name: "the browser's host is used and the nodes are not read",
			addr: inCluster,
			host: "192.0.2.50:30800", phase: "Completed",
			wantBase: "http://192.0.2.50:30901",
		},
		{
			name: "an Ingress name with no port",
			addr: inCluster,
			host: "dfaas.local", phase: "Completed", nodeIP: "192.0.2.10",
			wantBase: "http://dfaas.local:30901",
		},
		{
			name: "an IPv6 browser host is bracketed",
			addr: inCluster,
			host: "[2001:db8::1]:30800", phase: "Completed",
			wantBase: "http://[2001:db8::1]:30901",
		},
		{
			name: "localhost falls back to a node IP",
			addr: inCluster,
			host: "localhost:8082", phase: "Completed", nodeIP: "192.0.2.10",
			wantBase: "http://192.0.2.10:30901", wantLists: 1,
		},
		{
			name: "an IPv6 node IP is bracketed",
			addr: inCluster,
			host: "127.0.0.1:8082", phase: "Completed", nodeIP: "2001:db8::10",
			wantBase: "http://[2001:db8::10]:30901", wantLists: 1,
		},
		{
			name: "localhost and no addressable node give no results",
			addr: inCluster,
			host: "localhost:8082", phase: "Completed",
			wantLists: 1,
		},
		{
			name: "the filer override wins over the browser's host",
			addr: assetAddressing{FilerOverride: "https://files.lab.example", InCluster: true},
			host: "192.0.2.50:30800", phase: "Completed", nodeIP: "192.0.2.10",
			wantBase: "https://files.lab.example",
		},
		{
			name: "an external S3 config has no filer to browse",
			addr: inCluster,
			host: "192.0.2.50:30800", phase: "Completed", s3Config: "my-aws",
		},
		{
			name: "the explicit default config still gets links",
			addr: inCluster,
			host: "192.0.2.50:30800", phase: "Completed", s3Config: DefaultS3ConfigName,
			wantBase: "http://192.0.2.50:30901",
		},
		{
			name: "a running test has no results yet",
			addr: inCluster,
			host: "192.0.2.50:30800", phase: "Running",
		},
		{
			// go run on a laptop, opened at its LAN address: that host serves
			// no filer, the node the gateway itself dials does.
			name: "outside the cluster the browser's host is not used",
			host: "192.0.2.50:8082", phase: "Completed", nodeIP: "192.0.2.10",
			wantBase: "http://192.0.2.10:30901", wantLists: 1,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			objs := []runtime.Object{
				loadTestObj("lt-demo", "bari", tc.phase, false),
				assetEnvObj("bari", "uid-fake-1", tc.s3Config),
			}
			if tc.nodeIP != "" {
				objs = append(objs, nodeObj("node-a", tc.nodeIP))
			}
			h, nodeLists := resultsHandler(tc.addr, objs...)

			body := getLoadTest(t, h, tc.host)

			raw, present := body["results"]
			if tc.wantBase == "" {
				if present {
					t.Errorf("results = %s, want no results key", raw)
				}
			} else {
				var got LoadTestResults
				if !present {
					t.Fatalf("no results key; body = %v", body)
				}
				if err := json.Unmarshal(raw, &got); err != nil {
					t.Fatalf("decode results: %v", err)
				}
				want := LoadTestResults{
					MetricsURL: tc.wantBase + bucketPath + "/metrics/lt-demo/",
					K6URL:      tc.wantBase + bucketPath + "/k6/lt-demo/",
				}
				if got != want {
					t.Errorf("results = %+v, want %+v", got, want)
				}
			}
			if *nodeLists != tc.wantLists {
				t.Errorf("node lists = %d, want %d", *nodeLists, tc.wantLists)
			}
		})
	}
}
