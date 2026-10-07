# Development guide

For people changing this repository. User-level information (what the UI is, security warning,
configuration, how to run it) is in the [README](../README.md). What couples this repository to
the operator is in the operator's
[cross-repo contract](https://github.com/isired01/DFaaSOperator/blob/main/docs/cross-repo-contract.md).

## Code map

### Go gateway

| Path | Role |
|---|---|
| `cmd/server/main.go` | Builds the Kubernetes client, installs CORS, registers the routes, serves the SPA. Also serves `GET /healthz`, which the chart's probes use. If the Kubernetes client cannot be built the server still starts and every `/api` route answers `503`. |
| `internal/api/router.go` | `Handler`, `RegisterRoutes` (the one list of API routes) and `writeK8sError`, the mapping from a Kubernetes error to an HTTP status. |
| `internal/api/k8s_client.go` | `NewK8sClient` (in-cluster config, then `KUBECONFIG`, then `~/.kube/config`) and the GroupVersionResources the gateway uses. |
| `internal/api/handlers_environment.go` | Environment list, get, create, update, delete. Holds `activeLoadTestNames`, the guard that refuses an Environment edit or delete while a test holds it. |
| `internal/api/handlers_loadtest.go` | LoadTest list, get, create, delete, activate, abort. `CreateLoadTest` is the only handler that creates child resources (script ConfigMaps). |
| `internal/api/s3_configs.go` | The S3 config registry: Secrets in the `dfaas-s3` namespace, labelled `dfaas.io/s3-config`. |
| `internal/api/assets.go` | Asset upload. The one handler that does not go through the Kubernetes adapter: it talks S3 with `aws-sdk-go-v2`. Also the addressing rules for the baked URL (`assetAddressing`, plain struct with pure methods, table-tested). |
| `internal/api/results.go` | `resolveResultsURLs`: the filer links attached to a `Completed` LoadTest in `GET /api/loadtests/:namespace/:name`. No route of its own. |
| `internal/api/yaml_import.go`, `yaml_export.go` | Raw YAML create and download for both kinds. |
| `internal/api/types.go` | Request and response DTOs. They mirror the operator's CRDs by hand. |
| `internal/api/mappers.go` | Walks `unstructured` objects into the DTOs (`mapEnvDetail`, `mapLoadTestSummary`, `mapLoadTestDetail`, `mapConditions`, `nodeInfosFrom`). |
| `internal/api/schema.go` | The rule set served at `GET /api/meta/schema` and the validators that enforce it (`validateEnvNodes`, `validateLoadTest`). |
| `internal/api/dispatchgate.go` | Admission of a new LoadTest against the Environment's phase (`AdmitLoadTest`, `dispatchable`). |
| `internal/api/util.go` | Small helpers (`sanitizeDNS1123`, `getNestedString`, ...). |

Tests are the `*_test.go` files next to the code in `internal/api`. `cmd/server` has no tests.

### SPA (`ui/`)

| Path | Role |
|---|---|
| `ui/src/App.jsx` | Route table. Pages sit under `ui/src/pages/`: environments (list, new/edit, detail), load tests (list, new, detail), S3 configs (list, new, detail). |
| `ui/src/api/client.js` | Every call to the gateway. Components do not call `fetch` themselves. |
| `ui/src/components/` | Shared components (forms, `PhaseBadge`, `ConditionsList`, `K6ScenariosEditor`, `MetricsEditor`, `GeneratorProgress`, ...). |
| `ui/src/lib/` | Plain JavaScript with no React, so that Node can run it. The `*.selfcheck.mjs` files next to it are the tests. `useResource.js` is the one file that binds `resourcePoll.js` to React. |
| `ui/src/lib/payloads/` | Builders that turn a form draft into a request body (`loadtest.js`, `environment.js`). |
| `ui/vite.config.js` | Dev server on `5173`, `/api` proxied to `http://localhost:8082`. |

State is kept with `useState` and `useEffect`; there is no state library. Pages that show live
data poll every 5 seconds through `useResource`.

## REST routes

`RegisterRoutes` in `internal/api/router.go` is the source of truth.

| Method | Path | Handler | Notes |
|---|---|---|---|
| GET | `/api/meta/schema` | `GetSchema` | The rule set the SPA validates against. |
| GET | `/api/environments` | `ListEnvironments` | All namespaces. |
| GET | `/api/environments/:namespace/:name` | `GetEnvironment` | Includes node SSH credentials. |
| GET | `/api/environments/:namespace/:name/yaml` | `GetEnvironmentYAML` | The resource as YAML. |
| POST | `/api/environments` | `CreateEnvironment` | Structured body. |
| POST | `/api/environments/yaml` | `CreateEnvironmentFromYAML` | Raw YAML body. |
| PATCH | `/api/environments/:namespace/:name` | `UpdateEnvironment` | Merge patch of `spec.nodes` and `spec.s3ConfigRef`; the operator re-provisions. |
| DELETE | `/api/environments/:namespace/:name` | `DeleteEnvironment` | Guarded, see below. |
| GET | `/api/s3-configs` | `ListS3Configs` | |
| GET | `/api/s3-configs/:name` | `GetS3Config` | |
| POST | `/api/s3-configs` | `CreateS3Config` | |
| DELETE | `/api/s3-configs/:name` | `DeleteS3Config` | `403` for `seaweedfs-default`. |
| GET | `/api/loadtests` | `ListLoadTests` | Optional `?environment=<namespace>/<name>`. |
| GET | `/api/loadtests/:namespace/:name` | `GetLoadTest` | Inlines each script from its ConfigMap; a `Completed` test also gets the filer result links. |
| GET | `/api/loadtests/:namespace/:name/yaml` | `GetLoadTestYAML` | |
| POST | `/api/loadtests` | `CreateLoadTest` | Creates the script ConfigMaps, then the LoadTest. |
| POST | `/api/loadtests/assets` | `UploadLoadTestAsset` | Multipart upload to S3. |
| POST | `/api/loadtests/yaml` | `CreateLoadTestFromYAML` | Raw YAML body. |
| POST | `/api/loadtests/:namespace/:name/activate` | `ActivateLoadTest` | Start a draft or scheduled test now. |
| PATCH | `/api/loadtests/:namespace/:name/abort` | `AbortLoadTest` | Sets `spec.stop=true`. |
| DELETE | `/api/loadtests/:namespace/:name` | `DeleteLoadTest` | |

An unknown `/api/...` path answers a JSON `404`; any other unknown path serves the SPA's
`index.html`. Keep `ui/src/api/client.js` in step with this table.

## Status codes

Send Kubernetes errors through `writeK8sError` instead of choosing a status by hand. It maps
`NotFound` to 404, `AlreadyExists` and `Conflict` to 409, `Invalid` and `BadRequest` to 400, and
everything else to 500. Mapping by hand has reported a timeout on a Get as "not found".

| Status | Where and why |
|---|---|
| 200 | Delete requests (`message` body), reads. A second `DELETE` on an Environment that is already being deleted also answers 200, because the tests the operator is aborting still count as holding it and a 409 would read progress as a refusal. |
| 201 | Created (Environment, LoadTest, S3 config, asset). |
| 202 | `PATCH` of an Environment, `activate`, `abort`: the change is accepted and the operator acts on it. |
| 400 | Shape validation, before any cluster write, on both the structured and the YAML path: LoadTest (`validateLoadTest`), Environment nodes (`validateEnvNodes`), `startAt` without `suspended=true`, a `perNodeLoad[].nodeID` that is not a generator of the target Environment (the message lists the valid ones), a malformed `?environment=` filter, an `activate` on a test that is not suspended. |
| 403 | Deleting the built-in `seaweedfs-default` S3 config. Also the CORS middleware's answer to a disallowed origin, before any handler. |
| 404 | The resource, or the target Environment of a LoadTest, does not exist. Both create paths report a missing target Environment as 404, not 400. |
| 409 | Duplicate name (including a script ConfigMap name collision). Dispatch gate: a non-draft, non-scheduled LoadTest against an Environment that is not `Ready`. Environment `PATCH` or `DELETE` while a test holds the Environment (see `activeLoadTestNames`): `Running`, `Exporting`, not yet admitted or `Pending` and not suspended, or terminal with its runners not reclaimed. `activate` when the test has left `Pending`, or when it changed between the gateway's read and its patch (the patch carries the observed `resourceVersion`). Asset upload when the S3 config Secret is missing or an external config has no absolute http(s) `endpoint`. |
| 413 | Asset upload larger than 32 MiB (`http.MaxBytesReader`, so nothing is spilled to disk). |
| 424 | `POST /api/s3-configs` when the `dfaas-s3` namespace does not exist yet (`StatusFailedDependency`). |
| 500 | Anything else, including S3 errors during an upload. |
| 502 | Asset upload to `seaweedfs-default` when no node address can be found for the baked URL, so no k6 VM would be able to fetch the asset. Fix: let the gateway `list` Nodes, or set `SEAWEEDFS_PUBLIC_URL`. |
| 503 | Every `/api` route when the Kubernetes client could not be built. |

## How the gateway talks to Kubernetes

Every request is a live call through `dynamic.Interface` (unstructured). There are no informers,
no cache and no database. The gateway has no compile-time dependency on the operator's Go types:
Environments and LoadTests are `unstructured.Unstructured`, read with `unstructured.Nested*` and
mapped into the DTOs in `types.go` by `mappers.go`.

Consequence: **a CRD change never breaks this repository's build.** The DTOs drift silently and
the problem appears at run time (a field that is missing, or that the API server prunes). Every
mirrored field, rule and string is kept in step by hand; the checklist below lists where.

The gateway touches only `Environment`, `LoadTest`, ConfigMaps (the per-node scripts), Secrets in
`dfaas-s3` (S3 configs), and Nodes (read-only). It never touches `k6.io/v1alpha1 TestRun`; those
live on the remote generators' k3s clusters and belong to the operator.

Things that are easy to get wrong:

- Node `role` is the kebab-case enum `dfaas-worker` or `k6-load-generator`. The CRD rejects any
  other spelling; do not "fix" it to PascalCase.
- The LoadTest CRD carries only `perNodeLoad[].scriptConfigMap.name`, never a script body. The
  SPA sends inline scripts, `CreateLoadTest` writes each into a ConfigMap
  `<loadtest>-<nodeID>-script` (key `script.js`, labelled `dfaas.io/loadtest`,
  `dfaas.io/environment`, `dfaas.io/node-id`) and then sets an `ownerReference` to the LoadTest on
  each ConfigMap, so deleting the LoadTest garbage-collects them. If a later step fails, the
  ConfigMaps already created are deleted again.
- `unstructured.NestedSlice` panics on a document decoded by `yaml.v3`, because the decoded
  document holds plain Go `int` values the deep copy does not know. The YAML import round-trips
  the document through JSON (`normaliseJSON`) and the mappers read slices with
  `nestedSliceNoCopy`. `TestNestedSliceNoCopySurvivesADecodedYAMLDocument` first checks that the
  upstream helper does panic, so it fails if that ever changes.
- LoadTest names are capped at 63 characters (a name is used as a label value). A name the user
  does not set is generated as `lt-<env>-<timestamp>[-<suffix>]-<nonce>`, cut to 63 with the
  nonce kept.
- Asset upload addresses SeaweedFS through the `assetAddressing` struct in `assets.go`. The bucket
  name and key layout (`bucketNameFor`, `assets/<uuid>-<filename>`) are copied from the operator's
  `dataExporter/main.go`; uploads must land in the bucket the exporter reads.
- On every upload the gateway replaces the bucket's policy with an anonymous `s3:GetObject` grant
  on `assets/*` (any S3 config, not only the default one) and tags the object. An S3 provider
  that refuses public bucket policies (AWS S3 Block Public Access, on by default for new buckets)
  rejects the upload with `500`. A config used for image payloads therefore needs
  `s3:PutBucketPolicy` and `s3:PutObjectTagging` in addition to `s3:ListBucket`, `s3:CreateBucket`
  and `s3:PutObject`.

### Admission and guards

- **Dispatch gate.** A LoadTest that is neither a draft nor scheduled needs an Environment in
  phase `Ready`; nothing else dispatches. The rule exists three times and the three must agree:
  the operator's `EnvironmentPhase.Dispatchable()`, `dispatchable` in `dispatchgate.go`, and
  `env.dispatchable` in `ui/src/lib/crstate.js`. The gateway and the SPA must not be stricter
  than the operator. A draft or a scheduled test skips the gate, because it runs later.
- **`spec.startAt` needs `spec.suspended=true`.** The gateway refuses the combination with 400
  before writing; the operator fails such an object at admission. It is deliberately not a CRD
  validation rule, because that would also reject the operator's own PATCH that un-suspends a
  scheduled test at its deadline.
- **Environment edit and delete guard.** `activeLoadTestNames` counts as occupying a test that is
  `Running` or `Exporting`, a non-suspended test in phase `""` or `Pending`, and a terminal test
  whose summary has `runnersUnreclaimed`. The SPA's `lt.occupying` is the same rule, and
  `lt.holdReason` prints the same labels as the gateway's 409 message. Every Environment edit
  counts, `s3ConfigRef` included, because any spec change re-runs provisioning on every node.
- **Rule set.** The validation rules the CRD enforces (Go-duration patterns, the minimum of
  function tuning fields, unique `nodeID` and `ipAddress`, the node-count limit) are repeated in
  `schema.go` by hand, with the CRD as the source of truth, and served at `GET /api/meta/schema`.
  A few Environment rules exist only in the gateway (at least one node of each role, non-blank
  username and password, a function image on every function). The non-negative check on function
  tuning fields is enforced but not served. See
  [ADR-0001](https://github.com/isired01/DFaaSOperator/blob/main/docs/adr/0001-gateway-owns-the-validation-rule-set.md).

## SPA conventions

- **`ui/src/lib/crstate.js` is the one vocabulary for phases and Condition reasons**: labels,
  tones, the phase sets (`lt.inFlight`, `lt.terminal`, `lt.changing`, `lt.abortable`,
  `lt.occupying`, `lt.deletable`, `env.dispatchable`) and the curated table of Condition reasons.
  Put such a rule here, where a selfcheck covers it, and not in a component. An unknown phase
  renders as its own name, and a reason missing from the table renders readably from its
  identifier but with the tone `neutral`.
- **Terminal reasons must have the tone `error`.** The provisioning row shows an error instead of a
  spinner only when the reason's tone is `error`, and `ConditionsList` takes its dot colour from
  the same tone. A terminal reason the operator adds and this table omits therefore leaves the
  row spinning forever on a real failure. `crstate.selfcheck.mjs` asserts this against a list
  copied by hand from the `true` rows of `terminalFailure` in the operator's
  `api/v1/inventory_test.go` (it cannot read the Go file), asserts that `CheckFailed` and
  `JobCreationFailed` are `error` (retried without bound, need a human), and that the reasons the
  operator keeps retrying itself (`RunnersUnreclaimed`, `FetchFailed`, `ApplyFailed`,
  `StaleCleanupFailed`, `ScriptMirrorFailed`) are not. A new terminal reason goes into both
  lists.
- **Validation reads the served rules.** The payload builders and form components get
  `GET /api/meta/schema` through `ui/src/lib/schema.js` (`loadSchema`, `useSchema`) and do not
  keep their own copy of the patterns and limits. The user sees an inline error instead of a raw
  `400` or `422`.
- **Read policy.** Pages that poll use `createPoll` (`ui/src/lib/resourcePoll.js`) through
  `useResource`: one read in flight, no error flash between polls, aborted reads are not errors,
  and `stop()` releases the in-flight guard synchronously (under `React.StrictMode` the effect
  runs mount, cleanup, mount, and an asynchronous release would leave the second mount waiting
  for the next timer tick). `LoadTestDetail` stops polling once a test is terminal and has no
  `runnersUnreclaimed`.
- **Never `fetch` from a component.** Add a function to `api/client.js`.
- **The k6 generator** (`ui/src/lib/k6Generator.js`) produces the script that is sent as
  `perNodeLoad[].script`. Keep three rules when touching it or the scenario forms:
  every user string goes through `jsString()` (`JSON.stringify`), because raw interpolation of a
  URL such as `?q=O'Brien` produced a script that failed to parse on the remote runner; scenario
  names must be unique, because the generator keys a JavaScript object literal by name and a
  duplicate silently drops a scenario; per-scenario UI state is keyed by the stable
  `scenario.id`, never by array index.
- **Executors.** The scenario editor offers `ramping-arrival-rate` and `constant-arrival-rate`.
  Each has one entry in `EXECUTORS` (`ui/src/lib/scenarios.js`) holding its option block, its run
  length (`durationMs`), the form section, defaults and validation, so the emitted script and the
  progress-bar total cannot drift apart. k6 rejects an option that does not belong to the
  executor, on the remote runner after dispatch. VU-based executors are not offered; use "Paste
  raw JS" for those. Adding an executor takes an entry in `EXECUTORS` plus whatever inputs it
  needs in `K6ScenariosEditor`; a VU-based one also needs `renderScenario` to stop emitting
  `timeUnit`, `preAllocatedVUs` and `maxVUs`.
- **`perNodeLoad[].duration` is derived, not typed, for a generated script.** k6 never reads it;
  the script's `options.scenarios` decides how long the run lasts. The SPA computes it
  (`perNodeTotalMs` in `scenarios.js`: the maximum over scenarios of `startTime` plus the
  executor's run length) because the progress bar on the LoadTest page uses it as its total. For
  a raw script the user types it, and a wrong value only makes the bar wrong. The SPA always
  sends `vus: 1`; the gateway still validates `vus >= 1` for API and YAML callers, and k6 takes
  its VUs from the script.
- **Number inputs emit `0` when cleared**, so payload builders omit zero-valued function tuning
  fields and let the CRD defaults apply (an explicit `0` would violate the CRD's `Minimum=1`).
  The gateway rejects a negative value.
- **Metrics.** `DEFAULT_METRICS` in `MetricsEditor.jsx` uses `[5m]` rate windows and the pod
  selector `dfaas-agent.*`. A window needs at least two samples, and the management Prometheus
  federates at the interval set in the operator's `prometheus-values.yaml`, so keep the window at
  least four times that interval. The selector must match the Helm release name the operator gives
  the DFaaS agent, or the default metrics export nothing.
- **Accessibility.** `FormField` gives its single child an id through `useId()`; a hand-written
  row needs an explicit `htmlFor`/`id`, or an `aria-label` where there is no visible label.
  Icon-only buttons need `aria-label` and `title`. Use `text-surface-450` for muted text:
  `surface-500` fails WCAG AA contrast on the card background.
- **Form state** of the LoadTest form is kept per generator in the browser's `localStorage` under
  `loadtest_draft_<namespace>_<environment>_<nodeID>`; it is not a cluster resource. It is not the
  same as the "Save as Draft" submit mode, which creates a LoadTest with `spec.suspended=true`.

### SPA selfchecks

The SPA has no test framework. `npm run check` (in `ui/`) is a hand-written `&&` chain of plain
`node` assert scripts listed in `ui/package.json`:

- `src/lib/resourcePoll.selfcheck.mjs`
- `src/lib/crstate.selfcheck.mjs`
- `src/lib/k6Generator.selfcheck.mjs`
- `src/lib/duration.selfcheck.mjs`
- `src/lib/scenarios.selfcheck.mjs`
- `src/lib/payloads/loadtest.selfcheck.mjs`
- `src/lib/payloads/environment.selfcheck.mjs`

A new selfcheck runs only after it is appended to that chain; otherwise it sits in the tree and
asserts nothing. Whatever a selfcheck must cover has to be reachable from plain `node`, which is
why `lib/` holds no JSX, no React and no bundler-specific imports.

## Behaviour worth knowing

- **Drafts, scheduled starts and Start.** The create form never dispatches a test directly. It
  creates a draft (`spec.suspended=true`) or a scheduled test (`suspended=true` plus
  `spec.startAt`). Neither is checked against the Environment's phase. A scheduled test stays
  `Pending` until the operator un-suspends it at `startAt`, or until the Environment is `Ready`
  if it was not at the deadline. **Start** (`activate`) sets `suspended=false` and clears
  `startAt` in one patch, so on a scheduled test it means start now. A test created through the
  API or YAML import without `suspended` needs a `Ready` Environment.
- **The operator's export cool-down** is one minute between the end of the k6 run and the exporter
  Job, so the management Prometheus has federated the end of the run. A test sitting in
  `Exporting` for that minute is not hung; the `MetricsExported` condition carries reason
  `ExportCooldown` and a countdown.
- **Image payloads.** The generated script fetches an uploaded image once in k6's `setup()`
  (base64) and each VU POSTs the raw bytes. Each generator fetches it once, whatever the VU
  count. For an upload to `seaweedfs-default` the response carries `relocatable: true` and
  `path` (`/<bucket>/<key>`); the SPA stores `path` as `payloadImagePath`, and the script fetches
  `DFAAS_ASSET_BASE` + `path` when the operator injected `DFAAS_ASSET_BASE` on the runner, and
  the URL baked at upload time otherwise. A failed fetch calls `exec.test.abort()` naming the
  scenario, the URL and the HTTP status; on status 0 the message names where the URL came from.
  The operator does not yet surface this abort on the LoadTest itself (see the operator's
  [known limitations](https://github.com/isired01/DFaaSOperator/blob/main/docs/known-limitations.md)).
  Keep the image small and size it together with the arrival rate: a payload that is large
  relative to the rate saturates SeaweedFS, the network or the DFaaS node, and a high failure rate
  makes runs incomparable.
- **Synchronized start** (`spec.syncStart`). The form ticks "Synchronized start" by default when
  two or more generators are enabled, until the user changes it by hand. A generated script
  always has a `setup()` with `setupTimeout: '10m'`; when `DFAAS_SYNC_URL` is set it polls that
  URL until it answers 200 (a `sleep(0.25)` between polls). Those polls are ordinary k6
  requests, so they count in `http_reqs`, `http_req_duration` and `http_req_failed` of the
  exported summary. Read the load's failure rate from the `checks` metric: the generated
  "status is 2xx" check covers the load requests only. The operator publishes the GO signal when
  every remote TestRun reports `started`, which can come before every runner has reached the
  barrier, so runners can still start seconds apart.
- **Raw scripts need `handleSummary`.** Only generated scripts emit it. A script that is pasted,
  uploaded, POSTed or imported from YAML must `PUT` `JSON.stringify(data)` to
  `__ENV.DFAAS_SUMMARY_URL` from its own `handleSummary` (copy the generator's block), and with
  `syncStart` must also poll `__ENV.DFAAS_SYNC_URL` in `setup()`. Otherwise the k6 summary in the
  export holds only `dfaas_summary_fetched=0` rows and the test still ends `Completed`.
- **`DeleteS3Config`** does not check which Environments reference the config. A LoadTest whose
  Environment points at a deleted config fails at export with `S3ConfigMissing`.

## Keeping in step with the operator

Nothing here compiles against the operator, so each item below is a hand-kept mirror. When the
operator changes one of these, change the matching place here.

| Operator side | This repository |
|---|---|
| A CRD field (`api/v1/*_types.go`) | The DTO in `internal/api/types.go`, the mapper in `mappers.go`, the request builder (`buildEnvironmentUnstructured`, `buildLoadTestUnstructured`) if the field is writable, the YAML export key order in `yaml_export.go`, and the SPA component that shows or edits it. Regenerate the CRDs in the operator and copy them into the chart before the new operator runs, or the API server prunes the field. |
| A CRD validation rule (pattern, minimum, enum, CEL) | The rule set in `schema.go` (and `validateEnvNodes` or `validateLoadTest`), then the SPA payload builders if they use a new rule. |
| A Condition reason | The reason table in `ui/src/lib/crstate.js`. A terminal one (the object is dead) also goes into the hand-copied list in `crstate.selfcheck.mjs`, with tone `error`. |
| The dispatch gate (`EnvironmentPhase.Dispatchable`) | `dispatchable` in `dispatchgate.go` (and its test) and `env.dispatchable` in `crstate.js`. |
| The Environment occupancy rule | `activeLoadTestNames` in `handlers_environment.go` and `lt.occupying` / `lt.holdReason` in `crstate.js`. |
| How `observedGeneration` is stamped | The edit lock in `EnvironmentDetail.jsx`: a non-zero `status.observedGeneration` below `metadata.generation` means an update is in progress. The operator stamps it only when provisioning settles (`Ready` or `Failed`). |
| The runner environment variables (`DFAAS_SYNC_URL`, `DFAAS_SUMMARY_URL`, `DFAAS_ASSET_BASE`) | The generated script in `k6Generator.js`. |
| The management address of a generator (`status.k6Nodes[].managementAddress`) | `K6NodeStatus.ManagementAddress` in `types.go`, copied in `mapEnvDetail`, shown on the generator's `NodeCard`. Display only. See [ADR-0008](https://github.com/isired01/DFaaSOperator/blob/main/docs/adr/0008-detected-management-address-beats-env-fallbacks.md). |
| The federation interval of the management Prometheus | The `[5m]` rate windows in `MetricsEditor.jsx` (keep at least four times the interval). |
| The bucket name and key layout of the exporter (`dataExporter/main.go`) | `bucketNameFor` in `assets.go` and the key built in `UploadLoadTestAsset`. |
| The Helm release name of the DFaaS agent (`dfaas-agent`, set in the operator's `setup-nodes.yml`) | The `dfaas-agent.*` pod selector in `DEFAULT_METRICS` in `MetricsEditor.jsx`. |
| The k6-operator stage names (`created`, `started`, `finished`, `stopped`, `error`) | `testRun` in `crstate.js` and `GeneratorProgress.jsx`. The operator reports them from `loadtest_fleet.go`. |
| A new Kubernetes resource the gateway uses | A rule in the UI ClusterRole, `charts/dfaas/templates/ui-rbac.yaml` in the operator repository. |
| The length limit of a LoadTest name (a label value, so 63) | `maxLoadTestNameLen` in `schema.go` and `generatedLoadTestName` in `handlers_loadtest.go`. |

The two design decisions that govern this code are in the
[ADR-0001](https://github.com/isired01/DFaaSOperator/blob/main/docs/adr/0001-gateway-owns-the-validation-rule-set.md) (the
gateway owns the validation rule set and serves it to the SPA) and [ADR-0007](https://github.com/isired01/DFaaSOperator/blob/main/docs/adr/0007-keep-url-template-exports-in-client-js.md) (the one-line
URL-template exports in `client.js` stay; do not remove them to save lines).

## Driving the UI from a script

For browser automation and end-to-end checks:

- Generator fields mount only when the generator's checkbox is ticked (`NodeLoadConfig.jsx`).
  Select them by their `nodeID`-bearing ids (for example `duration-<nodeID>`) or by
  `aria-label` (for example `Raw k6 script for <nodeID>`), not by position.
- Fill every required field, or the browser's native validation blocks the submit before the SPA
  runs.
- For a negative API test, start from a valid document and change one field. The gateway reports
  only the first failing rule (`validateLoadTest` returns at the first error).
- An empty table renders one row holding the empty-state message, not zero rows.
- Measure against the production bundle served by the gateway on `:8082`, not the Vite dev
  server: `React.StrictMode` runs effects twice in development.
- `parseMetricsCsv` (`ui/src/lib/metricsCsv.js`) returns `{ metrics, errors }` and never throws.
