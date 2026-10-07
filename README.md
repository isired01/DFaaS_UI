# DFaaS Control Plane

Web UI and REST gateway for the [DFaaSOperator](https://github.com/isired01/DFaaSOperator). It
manages the operator's two custom resources, `Environment` (a federated DFaaS testbed: DFaaS nodes
and k6 load generators) and `LoadTest` (one k6 test against a `Ready` Environment), and manages
the S3 export configurations the operator uses for results.

The gateway needs the operator's CRDs (`dfaas.dfaas.io/v1`) in the cluster it talks to. In normal
use you do not build or deploy it yourself: the operator's Helm chart installs it together with
the operator. Installation is described in the
[DFaaSOperator README](https://github.com/isired01/DFaaSOperator#install-via-helm) and upgrades
(CRDs first, then the chart) in its
[Upgrade section](https://github.com/isired01/DFaaSOperator#upgrade).

System-level documentation lives in the operator repository:

- [Overview](https://github.com/isired01/DFaaSOperator/blob/main/docs/overview.md): what the system does and how the two repositories fit together
- [Cross-repo contract](https://github.com/isired01/DFaaSOperator/blob/main/docs/cross-repo-contract.md): what couples this repository to the operator
- [Known limitations](https://github.com/isired01/DFaaSOperator/blob/main/docs/known-limitations.md)
- [Glossary](https://github.com/isired01/DFaaSOperator/blob/main/docs/glossary.md)
- [Architecture decision records](https://github.com/isired01/DFaaSOperator/blob/main/docs/adr/README.md) (ADR-0001 and ADR-0007 concern code in this repository)

For developers of this repository: [docs/development.md](docs/development.md) (code map, REST
routes, status codes, how to follow a CRD change).

## What it is made of

- A Go (Gin) binary that exposes a REST API under `/api` and serves the compiled SPA. It keeps no
  state: every request is a live call to the Kubernetes API through the dynamic (unstructured)
  client. The one exception is asset upload, which talks to S3 directly.
- A React 19 SPA (Vite, Tailwind) in `ui/`. Its production build is written to `ui/dist/`.
- There is no `go:embed`. The container image holds `/app/server` and `/app/ui/dist` side by
  side, and the server looks for `ui/dist` next to its own binary, then under the working
  directory.

The UI manages Environments (create, edit, delete, live phase and per-node status), LoadTests
(create, save as draft, scheduled start, start, abort, delete), S3 export configurations, and raw
YAML import and export of both resources.

Names used for this component:

| Where | Name |
|---|---|
| Repository | `DFaaS_UI` |
| Go module | `dfaas-control-plane` |
| Container image | `ghcr.io/isired01/dfaas-control-plane` |
| npm package | `dfaas-control-plane-ui` |
| Helm chart values key | `ui` |
| Namespace | `dfaas-ui` |
| Service | `<release>-ui` (`dfaas-ui` for a release named `dfaas`) |

## Security

**The gateway has no authentication and no authorization.** The only middleware is CORS. Anyone
who can reach its port can:

- read every Environment, including each node's SSH `username` and `password` in clear text
  (`GET /api/environments/:namespace/:name` and its `/yaml` export);
- create, edit and delete Environments, which makes the operator run Ansible as root against the
  IP addresses in the request;
- create, start, abort and delete LoadTests, upload assets, and register and delete S3 configs.

S3 access keys are never returned by the API. The namespace in a request URL or body is used
without any check.

The operator's Helm chart publishes the UI on NodePort 30800 of every node by default. Keep it on
a trusted network (see also
[Exposing the UI](https://github.com/isired01/DFaaSOperator#exposing-the-ui) and the operator's
[known limitations](https://github.com/isired01/DFaaSOperator/blob/main/docs/known-limitations.md)).
On any other network install the chart with `--set ui.service.type=ClusterIP`
and reach the UI with `kubectl -n dfaas-ui port-forward svc/dfaas-ui 8082:8082`, or put an
authenticating proxy in front of it.

The gateway's ClusterRole is defined in the operator chart
(`charts/dfaas/templates/ui-rbac.yaml`). It can create and delete every Secret and ConfigMap in
the cluster, so a compromise of the gateway is a compromise of the cluster's secrets.

A registered S3 endpoint is not validated: the gateway dials it exactly as given when an asset is
uploaded, from inside the cluster.

### CORS

`CORS_ORIGINS` controls which browser origins may call the API. It is not access control.

| `CORS_ORIGINS` | Behaviour |
|---|---|
| unset | Allows `http://localhost:5173` (the Vite dev server) only. |
| set, empty (the chart's default) | The CORS middleware is not installed: no `Access-Control-*` headers are sent and no request is refused for its origin. |
| comma-separated list | A request carrying an `Origin` header that is neither in the list nor the request's own `http(s)://<Host>` is answered `403` before it reaches a handler. Entries must start with `http://` or `https://`; any other value makes the server panic at start-up. |
| contains `*` | Every origin is allowed. The gateway drops `Access-Control-Allow-Credentials` and logs a warning. Any page a user opens can then read every response, SSH passwords included, so list real origins instead. |

What this does and does not stop:

- With the empty setting, a page on another site can still make the browser send a "simple"
  cross-site request (a form-style `POST` with a `text/plain`, form or multipart body) to a
  reachable gateway, and the handler runs. The JSON handlers bind the body with
  `ShouldBindJSON`, which does not look at `Content-Type`, so such a request can create
  Environments, LoadTests and S3 configs, upload assets and start a draft (every `POST` route).
  `PATCH` and `DELETE` need a preflight, which the gateway does not answer, so the browser
  refuses to send them. The page cannot read any response.
- A non-empty list refuses such browser requests with `403`, because they carry an `Origin`
  header.
- Neither setting affects a client that sends no `Origin` header (`curl`, scripts, other
  servers): they reach every handler.

## Configuration

The gateway reads these environment variables. No `.env` file is loaded.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8082` | Port the server listens on. The chart sets it from `ui.service.port`. |
| `GIN_MODE` | unset | Read by Gin itself. Neither the image nor the chart sets it, so Gin runs in debug mode and prints its route table at start. Set it to `release` (for example `ui.env.GIN_MODE: release` in the chart values) to quiet that. |
| `KUBECONFIG` | unset | Path of one kubeconfig file, used only when the gateway is not running in a Pod. Unset falls back to `~/.kube/config`. A colon-separated list is not split: it is read as a single path. |
| `KUBERNETES_SERVICE_HOST` | set by Kubernetes in a Pod | Used only as the "running in the cluster" signal for SeaweedFS addressing (the same signal `rest.InClusterConfig` uses). Do not set it by hand. |
| `CORS_ORIGINS` | unset (dev origin); the chart sets it empty | See [CORS](#cors). |
| `SEAWEEDFS_ENDPOINT` | auto | Endpoint the gateway dials to upload an asset to the in-cluster SeaweedFS (`seaweedfs-default` only). Auto: the endpoint stored in the `seaweedfs-default` Secret (an in-cluster service address) when in a Pod, `http://<node-ip>:30900` when outside the cluster. |
| `SEAWEEDFS_PUBLIC_URL` | auto: `http://<node-ip>:30900` | Base of the absolute asset URL written into a generated k6 script at upload time (`seaweedfs-default` only). It is the fallback for runners that the operator gave no `DFAAS_ASSET_BASE`. Those runners must be able to reach it. |
| `SEAWEEDFS_FILER_PUBLIC_URL` | auto | Base URL of the SeaweedFS filer, used for the result links shown on a `Completed` LoadTest. Auto: the host the browser opened the UI on with port `30901` when the gateway runs in a Pod; a node IP when that host is loopback or otherwise unusable, or when the gateway runs outside the cluster. Set it when the UI sits behind an Ingress or proxy whose host does not expose the NodePorts. No links appear when the Environment exports to an external S3 config. |

The three `SEAWEEDFS_*` variables apply to the in-cluster SeaweedFS only. An external S3 config
keeps its own endpoint for both dialling and the URL baked into the script.

Auto-detecting the addresses above lists the cluster's Nodes, so the gateway needs `list` on
`nodes`; the chart's ClusterRole grants it. Without it an upload to `seaweedfs-default` answers
`502` unless `SEAWEEDFS_PUBLIC_URL` is set.

In the chart, set any of these through `ui.env` in the values file.

## Running locally

Prerequisites:

- Go 1.26 and Node.js 22 with npm.
- A cluster with the operator's CRDs installed. The simplest way to get one is to install the
  operator chart (see its [install instructions](https://github.com/isired01/DFaaSOperator#install-via-helm)). Asset upload also needs the `seaweedfs-default`
  Secret in the `dfaas-s3` namespace, which the operator creates; without it an upload answers
  `409`.
- A kubeconfig whose identity has the permissions of the UI ClusterRole in
  [`charts/dfaas/templates/ui-rbac.yaml`](https://github.com/isired01/DFaaSOperator/blob/main/charts/dfaas/templates/ui-rbac.yaml).
  What the gateway actually uses: `environments` and `loadtests` (get, list, create, patch,
  delete), `configmaps` (get, create, patch, delete), `secrets` in `dfaas-s3` (get, list, create,
  delete) and `nodes` (list).

The gateway, from the repository root:

```bash
export KUBECONFIG=/path/to/kubeconfig     # one file
go run ./cmd/server                       # API on http://localhost:8082
```

It resolves credentials in this order: the in-cluster ServiceAccount, then `KUBECONFIG`, then
`~/.kube/config` (only when `KUBECONFIG` is unset). If the configuration cannot be loaded the
server still starts, and every `/api` request answers `503`.

`ui/dist` is not tracked, so on a fresh clone `go run` serves the API only and logs
`frontend not found ... run 'npm run dev' in ui/`. Either run the dev server below or build the
SPA once with `cd ui && npm ci && npm run build`, after which the gateway serves it from
`ui/dist`.

The SPA with hot reload, in a second terminal:

```bash
cd ui
npm ci
npm run dev                               # http://localhost:5173
```

The Vite dev server listens on `5173` and proxies `/api` to `http://localhost:8082`
(`ui/vite.config.js`). Open the `5173` URL. `npm run preview` serves the built bundle on `4173`
with the same proxy, but its write requests carry the origin `http://localhost:4173`, which the
default CORS setting refuses with `403`. Start the gateway with
`CORS_ORIGINS=http://localhost:4173` to use it.

When the laptop cannot reach a node IP, uploads fail on the SeaweedFS connection. Forward the
S3 port and point the gateway at it:

```bash
kubectl -n monitoring port-forward svc/seaweedfs-all-in-one 8333:8333
SEAWEEDFS_ENDPOINT=http://localhost:8333 go run ./cmd/server
```

## Build and test

CI ([`.github/workflows/test.yml`](.github/workflows/test.yml)) runs these on every pull request
and every push to `main`:

```bash
go mod tidy -diff && go mod verify        # go.mod is tidy and matches go.sum
go vet ./...
go test ./...                             # gateway tests, in internal/api
cd ui
npm ci
npm run check                             # the SPA selfcheck chain
cd ..
docker build -t dfaas-control-plane .     # the image
```

`npm run build` (in `ui/`) produces the production bundle in `ui/dist/`. The SPA has no test
framework: `npm run check` is a chain of plain-`node` assert scripts, described in
[docs/development.md](docs/development.md#spa-selfchecks).

The [Dockerfile](Dockerfile) has three stages: the SPA is built with `node:22-alpine`, the
gateway with `golang:1.26-alpine` (static binary, `CGO_ENABLED=0`), and the runtime is
`alpine:3.22` holding `/app/server` and `/app/ui/dist`. It listens on `8082`. The frontend stage
always runs on the build platform, since its output does not depend on the architecture.

## Releases

The image is published by [`.github/workflows/release.yml`](.github/workflows/release.yml) when a
tag matching `v*` is pushed: `ghcr.io/isired01/dfaas-control-plane` tagged `vX.Y.Z`, `X.Y.Z` and
`latest`, for `linux/amd64` and `linux/arm64`. This repository and the operator release with the
same tag, even when this one did not change. The steps are in the operator's
[releasing guide](https://github.com/isired01/DFaaSOperator/blob/main/docs/releasing.md).

## License

Apache-2.0, see [LICENSE](LICENSE).
