# DFaaS Control Plane — UI & API Gateway

Web control plane for the **DFaaS** (distributed Function-as-a-Service) system. It drives the
[dfaas-operator](https://github.com/isired01/DFaaSOperator)'s two CRDs (`dfaas.dfaas.io/v1`):
create and monitor `Environment` federations, configure and launch k6 `LoadTest`s, and view the
state of the edge/cloud federation.

## Architecture

Two parts shipped as **one Go binary** in production:

1. **Frontend (React 19 + Vite + Tailwind)** — a reactive SPA. In production it is compiled to
   static assets and served by the backend; unknown non-API paths fall through to `index.html` for
   client-side routing.
2. **Backend (Go + Gin)** — a stateless API gateway that talks to the Kubernetes cluster through
   the **dynamic client** (unstructured). No informers, no schema dependency on the operator's
   typed Go types, no persistence — every read is a live cluster call.

What the UI manages: Environments (create/edit/delete, live phase + per-node status), LoadTests
(structured create, **save-as-draft** via `spec.suspended`, **scheduled start** via `spec.startAt`,
**Start** of a draft or scheduled test, **abort** via `spec.stop`, delete), S3 export
configurations, and raw-YAML import/export of both CRs.

## Install via Helm

The UI is packaged in the **same unified chart** as the operator. The chart carries the two CRDs,
and `helm install` applies them:

```bash
# 1. Install the chart (operator + UI + CRDs)
helm install dfaas oci://ghcr.io/isired01/charts/dfaas \
  --version 3.5.0 \
  --create-namespace \
  --namespace dfaas-operator-system

# 2. Open the UI: the Service is a NodePort on 30800 by default
open http://<node-ip>:30800
# or through a port-forward:
kubectl -n dfaas-ui port-forward svc/dfaas-ui 8082:8082   # then http://localhost:8082
```

**Upgrading:** `helm upgrade` never updates CRDs. Apply the new release's CRDs first, or the API
server prunes the fields the new operator writes. For v3.5.0 that is
`status.provisioningGeneration`; without it, an Environment edit saved while the Environment is
still provisioning is marked as applied, although the run in progress was provisioning the
previous spec.

```bash
kubectl apply -f https://github.com/isired01/DFaaSOperator/releases/download/v3.5.0/dfaas.dfaas.io_environments.yaml
kubectl apply -f https://github.com/isired01/DFaaSOperator/releases/download/v3.5.0/dfaas.dfaas.io_loadtests.yaml
helm upgrade dfaas oci://ghcr.io/isired01/charts/dfaas --version 3.5.0 --namespace dfaas-operator-system
```

Custom Resource examples (`Environment` + `LoadTest`) and VM IP configuration: see the
[DFaaSOperator README](https://github.com/isired01/DFaaSOperator#install-via-helm).

## Prerequisites (development)

- **Go** ≥ 1.26
- **Node.js** ≥ 20 and **npm**
- **kubectl** configured for access to a Kubernetes cluster

## Development setup

For development, run the frontend and backend separately to get Hot Module Replacement (HMR).

### 1. Frontend

```bash
cd ui
npm install
npm run dev        # http://localhost:5173 — Vite proxies /api → :8082
```

### 2. Backend

In another terminal, from the repo root:

```bash
go run ./cmd/server        # http://localhost:8082
```

The backend serves the API and (in production) the compiled SPA. In dev, the Vite server proxies
`/api/*` to the backend, so use the `:5173` URL.

## Cluster connection

The backend resolves Kubernetes credentials in this order (see
[`internal/api/k8s_client.go`](internal/api/k8s_client.go)):

1. **In-cluster** ServiceAccount (when running as a Pod).
2. `KUBECONFIG` environment variable.
3. `~/.kube/config`, only when `KUBECONFIG` is unset.

If the chosen config cannot be loaded, the server still starts but every `/api/*` request
returns `503`; a broken `KUBECONFIG` does not fall back to `~/.kube/config`. A config that loads
but points at an unreachable cluster fails per request instead.

```bash
# Local run against a specific kubeconfig:
export KUBECONFIG=/path/to/cluster-config.yaml
go run ./cmd/server
```

## Configuration

The server reads environment variables directly (no `.env` file is loaded):

- `PORT` — port the server listens on (default `8082`).
- `GIN_MODE` — set to `release` in production.
- `KUBECONFIG` — kubeconfig path for local (out-of-cluster) runs.
- `CORS_ORIGINS` — comma-separated allow-list of browser origins for the API (empty = same-origin only; unset = the dev origins `http://localhost:5173` and `http://localhost:3000`). The chart sets it empty; override via `ui.env`.
- `SEAWEEDFS_PUBLIC_URL` — public base URL for uploaded k6 image assets, reachable **from every k6 generator** (e.g. `http://<node-ip>:30900`; on a multi-site lab, the management node's tailnet IP, not its LAN one). See "Image payloads in k6 load tests".
- `SEAWEEDFS_ENDPOINT` — override for the gateway→SeaweedFS **dial** endpoint (default: auto — in-cluster DNS, or node-IP:30900 in dev).
- `SEAWEEDFS_FILER_PUBLIC_URL` — base URL of the SeaweedFS filer for the result links a `Completed` test shows (default `http://<node-ip>:30901`). No links appear when the Environment exports to an external S3 config.

> **`CORS_ORIGINS=*` is not usable as an origin list.** The server always sends `Access-Control-Allow-Credentials: true`, and the CORS spec forbids pairing that with a `*` origin — browsers silently refuse such responses. On startup the gateway warns and disables credentials rather than shipping a combination that cannot work. List the real origins instead.

**RBAC: the gateway needs `nodes` read access.** Auto-detecting the public asset URL lists cluster Nodes to find a reachable IP. The chart's UI ClusterRole grants core `nodes` `get`/`list` for this; without it an asset upload to the default SeaweedFS fails with **502** unless `SEAWEEDFS_PUBLIC_URL` is set (and `SEAWEEDFS_ENDPOINT`, when the gateway runs outside the cluster).

## Image payloads in k6 load tests

A k6 scenario can carry an uploaded image as its request body — e.g. to load-test an image-processing function like `dfaas-imgproc`.

- **Upload** (`POST /api/loadtests/assets`, [internal/api/assets.go](internal/api/assets.go)): the gateway stores the file in the Environment's bucket on its S3 config (the in-cluster SeaweedFS unless `spec.s3ConfigRef` names another; `assets/` prefix, anonymous-readable) and returns a public URL.
- **Script generation** ([ui/src/lib/k6Generator.js](ui/src/lib/k6Generator.js)): the k6 script fetches the image **once** in `setup()` (base64-encoded), and each VU decodes it once and POSTs the **raw bytes**. SeaweedFS is hit a single time regardless of VU count — not once per VU. If the `setup()` fetch fails, the script calls `exec.test.abort()` naming the scenario, the URL and the status: a test cannot run without its image, so it does not run at all rather than silently measuring something else.
- **Reachability / config:**
  - `SEAWEEDFS_PUBLIC_URL=http://<node-ip-reachable-from-k6-VMs>:30900` — the asset URL must be reachable **from every k6 generator** (on a multi-site lab, the management node's tailnet IP). Port **30900** = SeaweedFS S3 API (object GET). Auto-detect picks a node IP from the k8s node status, which on a multi-subnet lab may not be the routable one → set this explicitly. **Re-upload** the image after changing it (the URL is baked into the script at upload time). A generator that cannot reach it aborts its test in `setup()` naming the scenario, the URL and the HTTP status, rather than running the load unmeasured.
  - Target URL = `http://<dfaas-node-ip>:30080/function/<name>` (HAProxy NodePort on the DFaaS node — not the k6 node, not the gateway).
- **Use a small image** (KB, not multi-MB): the base64 payload is copied per-VU (runner memory) and the function receives the full image on **every** request — a large image saturates SeaweedFS / network / DFaaS node under load (symptoms: `unknown format` from failed fetches, `500/504` from a saturated node). Keep the arrival rate sane.

## Drafts, scheduled starts and Start

The create form saves a test as a **draft** (`spec.suspended=true`) or as a **scheduled** test
(`suspended=true` plus `spec.startAt`); it never dispatches one directly. Neither kind is checked
against the Environment's phase, so both can be created while the Environment is still provisioning.

- **Start** on the detail page (`POST /api/loadtests/:namespace/:name/activate`) sets
  `suspended=false` and removes `startAt` in one patch, so Start on a scheduled test starts it now
  and drops the schedule. It answers **409** once the test has left `Pending` or when the test
  changes while the request is in flight, and **400** when the test is not suspended.
- A scheduled test stays `Pending` until `startAt`. The operator then un-suspends it itself if the
  Environment is `Ready`; otherwise the test stays suspended (`Scheduled` reason
  `ScheduledDelayedEnvNotReady`) and fires once the Environment is `Ready`.
- A started test waits while its Environment is not `Ready`, and queues behind any other test that
  holds the same Environment (`Queued` condition). A test that ended with a runner the operator
  could not delete (`K6Healthy` reason `RunnersUnreclaimed`) keeps holding it; the operator retries
  the delete every 30 s, and deleting that test releases the Environment.
- A test created without `suspended` (through the API or a YAML import) needs a `Ready`
  Environment, otherwise the gateway answers **409**. `startAt` without `suspended: true` is a
  **400**.
- When k6 finishes the test moves to `Exporting`, and the exporter Job starts 30 s later so the
  management Prometheus has federated the end of the run (`MetricsExported` reason
  `ExportCooldown`, with a countdown).
- **Delete** is disabled on the detail page while the test is `Running` or `Exporting`: abort a
  running test first, or wait for the export to finish. Deleting a test that has not ended aborts
  it, and the operator deletes its runners on every generator it can reach.

## Validation

The gateway validates every Environment and LoadTest submission before it writes anything, and the
SPA checks the same rules inline: the gateway serves them at `GET /api/meta/schema`
([internal/api/schema.go](internal/api/schema.go)). Most are hand-synced copies of the operator's
CRD rules. A few Environment rules exist only in the gateway, so a `kubectl apply` is not held to
them: one node of each role, a non-blank username and a non-empty password, a non-blank image on
every function. The non-negative check on function tuning fields is enforced but not served. A
rule failure is a **400** that names the field. The form's `POST /api/loadtests` and the YAML
import (`POST /api/loadtests/yaml`) go through the same checks, so an imported document is held to
the same rules as the form.

- **LoadTest:** a name, when given, is a DNS-1123 name of at most 63 characters; at least one
  `perNodeLoad` entry, each with a `nodeID` that is a k6-load-generator of the target Environment
  (no duplicates), `vus` ≥ 1, a Go-duration `duration`, and exactly one of an inline `script` or a
  `scriptConfigMap` (a YAML document must name `scriptConfigMap.name`, since the CR carries no
  inline script); at least one metric, each with a valid `type` and a query, plus a `metricName`
  for `custom-promql`; `metricsExport.step`, when set, is a Go duration.
- **Environment** (create, edit and YAML import): at most 50 nodes and at least one of each role;
  `nodeID` a DNS-1123 label, unique; `ipAddress` unique; `username` and `password` on every node;
  every DFaaS node deploys at least one function; function names use lowercase letters and digits
  only (no `-` or `_`); every function names an image; function tuning fields are not negative.

Editing **or deleting** an Environment is refused with **409** while one of its tests is `Running`,
`Exporting`, started and waiting to dispatch, or ended with its runners not reclaimed (`K6Healthy`
reason `RunnersUnreclaimed`: delete the test to release the Environment). Every edit counts,
`s3ConfigRef` included, because any spec change re-runs provisioning on every node. Drafts and armed
schedules do not block the edit. A second delete while the operator's finalizer is already draining
the Environment answers **200**, not another 409.

## Load-test progress

The LoadTest detail page draws **one progress bar per generator**, next to that node's run stage.
It counts `status.startTime` against the node's declared `duration`, and colours from the remote
k6 stage: amber while running, green on `finished`, red on `error`.

The elapsed side is exact. The total is a *declaration*, so the bar is explicit about the limits of
what it knows — if the run passes its declared length while the runner is still going, the bar
switches to indeterminate rather than sitting at 99% pretending.

**Where that declaration comes from.** k6 never reads `spec.perNodeLoad[].duration`; the script's own
`options.scenarios` decides how long the run lasts. The field used to be a free text box that drove
nothing, and it was wrong out of the box — the default said `30s` for a default scenario that runs
`50s`. Now:

- **Generated scripts** — computed for you and shown read-only: the longest scenario, `startTime`
  plus its stages (or plus its `duration`, for a constant-arrival-rate scenario). Edit a stage and
  the number follows. This is also the only check stage durations get, since they live inside the
  script where the CRD cannot reach them.
- **Raw pasted scripts** — you still type it, because nobody can parse arbitrary JS. Get it wrong and
  only the bar is wrong; the test itself is unaffected.

## Known limitation — k6 executors

**The scenario editor generates only the two arrival-rate executors:**
`ramping-arrival-rate` (the rate follows `stages`) and `constant-arrival-rate`
(a flat `rate` for one `duration`). Each emits its own option set from the
executor registry in [ui/src/lib/scenarios.js](ui/src/lib/scenarios.js);
`renderScenario` in [ui/src/lib/k6Generator.js](ui/src/lib/k6Generator.js) adds
`timeUnit`, `preAllocatedVUs` and `maxVUs` to every scenario, which both accept.
k6 rejects options that do not belong to the executor, on the remote runner after
dispatch: the runner reports `error` and the operator fails the LoadTest. A
generated script does not hit this. A raw pasted script with the wrong options
for its executor does, and so would a new executor whose options do not match.

The VU-based executors (`constant-vus`, `ramping-vus`, `shared-iterations`,
`per-vu-iterations`) are not offered, because the generator does not emit their
options. For those, use **Paste raw JS** on the generator; its run length for the
progress bar is then typed by hand. Adding an executor to the form takes an entry
in `EXECUTORS` (option block, run length, validation, defaults) plus whatever
inputs it needs in `K6ScenariosEditor`; a VU-based one also needs
`renderScenario` to stop emitting the three arrival-rate options.

Steady plateaus, bursts and sawtooth spikes are all expressible with `stages`,
and several scenarios can run concurrently on one generator with different
`startTime` offsets. Arrival-rate is also the better model for these
experiments: it holds throughput as a controlled independent variable instead of
letting it fall out of how fast the system happens to respond.

## Verification

CI ([.github/workflows/test.yml](.github/workflows/test.yml)) runs these on every push to `main`
and every pull request:

```bash
go vet ./... && go test ./...            # gateway
(cd ui && npm ci && npm run check)       # SPA selfcheck scripts
docker build -t dfaas-control-plane .    # the image, which also runs npm run build and go build
```

The SPA has no test framework: `npm run check` is a chain of plain-`node` assert scripts
(`ui/src/lib/**/*.selfcheck.mjs`), and a new one runs only once it is appended to that chain in
[ui/package.json](ui/package.json).
