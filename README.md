# DFaaS Control Plane — UI & API Gateway

Web control plane for the **DFaaS** (distributed Function-as-a-Service) system. It drives the
[dfaas-operator](https://github.com/isired01/DFaaSOperator)'s two CRDs (`dfaas.dfaas.io/v1`):
create and monitor `Environment` federations, configure and launch k6 `LoadTest`s, and view the
state of the edge/cloud federation.

## Architecture

Two parts shipped as **one Go binary** in production:

1. **Frontend (React 19 + Vite + Tailwind)** — a reactive SPA. In production it is compiled to
   static assets and served by the backend; unknown paths fall through to `index.html` for
   client-side routing.
2. **Backend (Go + Gin)** — a stateless API gateway that talks to the Kubernetes cluster through
   the **dynamic client** (unstructured). No informers, no schema dependency on the operator's
   typed Go types, no persistence — every read is a live cluster call.

What the UI manages: Environments (create/edit/delete, live phase + per-node status), LoadTests
(structured create, **save-as-draft** via `spec.suspended`, **scheduled start** via `spec.startAt`,
**abort** via `spec.stop`, delete), S3 export configurations, and raw-YAML import/export of both
CRs.

## Install via Helm

The UI is packaged in the **same unified chart** as the operator:

```bash
# 1. Install the CRDs (the chart does not package them), then the chart:
kubectl apply -f https://github.com/isired01/DFaaSOperator/releases/download/v0.1.0/dfaas.dfaas.io_environments.yaml
kubectl apply -f https://github.com/isired01/DFaaSOperator/releases/download/v0.1.0/dfaas.dfaas.io_loadtests.yaml

# 2. Install the chart (operator + UI)
helm install dfaas oci://ghcr.io/isired01/charts/dfaas \
  --version 0.1.0 \
  --create-namespace \
  --namespace dfaas-operator-system

# 3. Open the UI
kubectl -n dfaas-ui port-forward svc/dfaas-ui 8082:8082
open http://localhost:8082
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
3. `~/.kube/config`.

If the cluster connection fails, the server still starts but every `/api/*` request returns `503`.

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
- `CORS_ORIGINS` — comma-separated allow-list of browser origins for the API (empty = same-origin only). Helm-injectable via `ui.env` in the chart.
- `SEAWEEDFS_PUBLIC_URL` — public base URL for uploaded k6 image assets, reachable **from the k6 VMs** (e.g. `http://<node-ip>:30900`). See "Image payloads in k6 load tests".
- `SEAWEEDFS_ENDPOINT` — override for the gateway→SeaweedFS **dial** endpoint (default: auto — in-cluster DNS, or node-IP:30900 in dev).

## Image payloads in k6 load tests

A k6 scenario can carry an uploaded image as its request body — e.g. to load-test an image-processing function like `dfaas-imgproc`.

- **Upload** (`POST /api/loadtests/assets`, [internal/api/assets.go](internal/api/assets.go)): the gateway stores the file in the in-cluster SeaweedFS (S3) under the Environment's bucket (`assets/` prefix, anonymous-readable) and returns a public URL.
- **Script generation** ([ui/src/lib/k6Generator.js](ui/src/lib/k6Generator.js)): the k6 script fetches the image **once** in `setup()` (base64-encoded), and each VU decodes it once and POSTs the **raw bytes**. SeaweedFS is hit a single time regardless of VU count — not once per VU. If the `setup()` fetch fails, VUs skip the POST (check `payload image available: false`) instead of sending a non-image body.
- **Reachability / config:**
  - `SEAWEEDFS_PUBLIC_URL=http://<node-ip-reachable-from-k6-VMs>:30900` — the asset URL must be reachable **from the k6 VMs**. Port **30900** = SeaweedFS S3 API (object GET). Auto-detect picks a node IP from the k8s node status, which on a multi-subnet lab may not be the routable one → set this explicitly. **Re-upload** the image after changing it (the URL is baked into the script at upload time).
  - Target URL = `http://<dfaas-node-ip>:30080/function/<name>` (HAProxy NodePort on the DFaaS node — not the k6 node, not the gateway).
- **Use a small image** (KB, not multi-MB): the base64 payload is copied per-VU (runner memory) and the function receives the full image on **every** request — a large image saturates SeaweedFS / network / DFaaS node under load (symptoms: `unknown format` from failed fetches, `500/504` from a saturated node). Keep the arrival rate sane.

## Verification

```bash
go build ./...                 # gateway compiles
cd ui && npm install && npm run build   # SPA builds
```

There is no automated test suite; `go build` + `npm run build` are the verification gates.
