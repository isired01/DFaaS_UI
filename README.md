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
# 1. Install the chart (operator + UI)
helm install dfaas oci://ghcr.io/isired01/charts/dfaas \
  --version 1.0.0 \
  --create-namespace \
  --namespace dfaas-operator-system

# 2. Open the UI
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

## Verification

```bash
go build ./...                 # gateway compiles
cd ui && npm install && npm run build   # SPA builds
```

There is no automated test suite; `go build` + `npm run build` are the verification gates.
