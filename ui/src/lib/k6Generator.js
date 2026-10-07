// k6 script generator. Pure function: scenarios -> JS script string.
// Nothing outside this script controls the run: k6 reads options.scenarios and
// nothing else. The LoadTest CRD's spec.perNodeLoad[].vus and .duration reach
// neither k6 nor the k6-operator TestRun — .duration is derived back FROM the
// scenarios below (perNodeTotalMs in lib/scenarios.js) purely so the UI can
// draw a progress bar.
// VUs are per scenario, via preAllocatedVUs / maxVUs.
// The env vars the operator injects (DFAAS_SYNC_URL, DFAAS_SUMMARY_URL,
// DFAAS_ASSET_BASE) only say where the runner dials back, never how much load.

import { EXECUTORS, DEFAULT_EXECUTOR, executorOf, hasImage, relocatablePath, effectiveMethod, jsString, validateScenarios } from './scenarios.js';

// renderScenario emits one k6 scenario. The executor-specific option block
// comes from the scenario registry (lib/scenarios.js), which is also where the
// runtime totaliser and the editor read the same shape — so the three cannot
// drift. k6 rejects an option set that does not match its executor, and that
// rejection lands on the remote runner after dispatch, where nobody sees it.
function renderScenario(s) {
  const executor = EXECUTORS[s.executor] ? s.executor : DEFAULT_EXECUTOR;
  return `    ${jsString(s.name)}: {
      executor: '${executor}',
${executorOf(s).renderOptions(s)}
      timeUnit: '1s',
      preAllocatedVUs: ${s.preAllocatedVUs ?? 10},
      maxVUs: ${s.maxVUs ?? 50},
      startTime: ${jsString(s.startTime || '0s')},
      exec: 'runScenario',
      env: { SCENARIO_ID: ${jsString(s.name)} },
    },`;
}

function renderConfig(s, idx) {
  const headers = s.headers && s.headers.trim() ? s.headers.trim() : '{}';
  const method = effectiveMethod(s);
  if (hasImage(s)) {
    // Body bytes are fetched ONCE in setup() and handed to each VU as base64;
    // __getImg_<idx>(data) decodes them per VU. The config exposes the loader +
    // content type so the request builder can attach both.
    return `  ${jsString(s.name)}: {
    method: '${method}',
    url: ${jsString(s.targetURL || '')},
    bodyLoader: __getImg_${idx},
    contentType: ${jsString(s.payloadContentType || 'application/octet-stream')},
    headers: ${headers},
  },`;
  }
  const body = s.body ? jsString(s.body) : 'null';
  return `  ${jsString(s.name)}: {
    method: '${method}',
    url: ${jsString(s.targetURL || '')},
    body: ${body},
    headers: ${headers},
  },`;
}

// renderSetup emits the once-per-test setup() that fetches every image payload
// a SINGLE time and base64-encodes it. k6 forbids HTTP in the init context and
// runs setup() exactly once, so this is what turns N fetches (one per VU) into
// one fetch total — the object store is hit once regardless of VU count. Binary
// can't survive setup-data JSON serialization to the VUs, hence base64.
//
// The sync barrier is emitted LAST, after any image fetches, so that payload
// warmup happens while we wait: when DFAAS_SYNC_URL is injected (synchronized
// start), every generator busy-waits until the operator publishes the "GO"
// signal (HTTP 200) so all runners begin load together. The barrier is guarded
// by the env var to stay backwards-compatible when sync start is off.
//
// setup() is always emitted (even with no images) and always returns
// { payloads } — an empty object when there are no images — so the per-VU image
// decoders keep reading data.payloads unchanged. Where each payload is fetched
// from (DFAAS_ASSET_BASE or the baked URL) is renderFetch's call.
function renderSetup(imageScenarios) {
  const fetches = imageScenarios.map(renderFetch);
  const barrier =
`  // Synchronized start: wait for the operator's GO signal (HTTP 200) so every
  // generator begins its load at the same moment. No-op unless DFAAS_SYNC_URL
  // is injected, keeping non-synchronized runs backwards-compatible.
  if (__ENV.DFAAS_SYNC_URL) {
    while (http.get(__ENV.DFAAS_SYNC_URL).status !== 200) { sleep(0.25); }
  }`;
  const body = [...fetches, barrier].join('\n');
  return `export function setup() {
  const payloads = {};
${body}
  return { payloads };
}`;
}

// The status-0 hints. Status 0 means no HTTP answer at all, so the hint names
// the setting that produced the unreachable address: the management address
// the operator detected, for a DFAAS_ASSET_BASE fetch; SEAWEEDFS_PUBLIC_URL
// (else the node IP), for the URL the gateway baked at upload. Naming the wrong
// one sends the user to fix a setting that played no part. One known miss: an
// external S3 config's asset carries no path, so it gets the path-less block,
// and its hint names SEAWEEDFS_PUBLIC_URL although its URL is that config's own
// endpoint. Both hints are emitted inside single-quoted literals, so neither
// may contain an apostrophe.
const BAKED_URL_HINT = `'; SEAWEEDFS_PUBLIC_URL must be reachable from every k6 generator'`;
const ASSET_BASE_HINT = `'; DFAAS_ASSET_BASE (the management address detected for this generator at provisioning, S3 NodePort 30900) must be reachable from this generator: open the port or re-provision the Environment'`;

// renderFetch emits one block-scoped payload fetch for setup().
//
// Where it fetches from: a scenario with an object path (only uploads to the
// in-cluster SeaweedFS carry one, see relocatablePath) prefers DFAAS_ASSET_BASE
// + path. The operator injects DFAAS_ASSET_BASE per generator, built on the
// management address it detected for THAT generator at provisioning, so each
// runner dials an address it can route to. Unset or empty means not detected
// (the test is truthiness, never !== undefined: an injected '' would otherwise
// build a relative URL), and the script fetches the URL the gateway baked at
// upload. One trailing '/' is trimmed with endsWith/slice: a regex written in
// this template would need every backslash doubled, and a missed one turns
// into a line comment on the remote runner.
//
// A scenario without a path emits exactly the block it always did, so old
// drafts and external-S3 assets get today's script. Either way the abort names
// the URL actually fetched.
function renderFetch(s) {
  const path = relocatablePath(s);
  let preamble = '';
  let url = jsString(s.payloadImageURL);
  let hint = BAKED_URL_HINT;
  if (path) {
    preamble = `
    const __raw = __ENV.DFAAS_ASSET_BASE || '';
    const __base = __raw.endsWith('/') ? __raw.slice(0, -1) : __raw;
    const __u = __base ? __base + ${jsString(path)} : ${jsString(s.payloadImageURL)};`;
    url = '__u';
    hint = `(__base ? ${ASSET_BASE_HINT} : ${BAKED_URL_HINT})`;
  }
  return `  {${preamble}
    const __r = http.get(${url}, { responseType: 'binary' });
    if (__r.status === 200 && __r.body && __r.body.byteLength > 0) {
      payloads[${jsString(s.name)}] = encoding.b64encode(__r.body);
    } else {
      exec.test.abort('setup: payload image for scenario ' + ${jsString(s.name)} + ' could not be fetched from ' + ${url} + ' (status=' + __r.status + (__r.error ? ', ' + __r.error : '') + ')' + (__r.status === 0 ? ${hint} : ''));
    }
  }`;
}

// renderImageDecoder emits a per-VU lazy decode of the payload that setup()
// fetched once and passed in as base64. Decoded to an ArrayBuffer once per VU;
// null when setup() never ran at all (e.g. `k6 run --no-setup`) — a real
// setup() fetch failure aborts the test from inside setup() itself (see
// renderSetup), so this branch is defensive, not the primary failure path.
function renderImageDecoder(s, idx) {
  return `let __img_${idx} = undefined;
function __getImg_${idx}(data) {
  if (__img_${idx} === undefined) {
    const __b64 = (data && data.payloads) ? data.payloads[${jsString(s.name)}] : null;
    __img_${idx} = __b64 ? encoding.b64decode(__b64, 'std', 'b') : null;
  }
  return __img_${idx};
}`;
}

export function generateK6Script(scenarios) {
  if (!scenarios || scenarios.length === 0) return '';

  // One enforcement point for the scenario rules. The form validates too, but
  // callers that build scripts directly (tests, tooling) bypass it — fail
  // loudly rather than emit a script that runs fewer scenarios than it lists.
  const errs = validateScenarios(scenarios);
  if (errs.length > 0) throw new Error(errs[0]);

  const imageScenarios = scenarios.filter(hasImage);
  const anyImage = imageScenarios.length > 0;

  const scenariosBlock = scenarios.map(renderScenario).join('\n');
  const configBlock = scenarios.map((s, i) => renderConfig(s, i)).join('\n');
  const decoderBlock = scenarios
    .map((s, i) => (hasImage(s) ? renderImageDecoder(s, i) : null))
    .filter(Boolean)
    .join('\n\n');
  // setup() is always emitted: it carries the sync barrier, so it must exist
  // even when there are no image payloads to fetch.
  const setupBlock = renderSetup(imageScenarios);

  return `import http from 'k6/http';
import { check, sleep } from 'k6';${anyImage ? `\nimport encoding from 'k6/encoding';\nimport exec from 'k6/execution';` : ''}

export const options = {
  setupTimeout: '10m',
  scenarios: {
${scenariosBlock}
  },
};

${setupBlock}

${decoderBlock ? `${decoderBlock}\n\n` : ''}const scenarioConfig = {
${configBlock}
};

export function runScenario(data) {
  const conf = scenarioConfig[__ENV.SCENARIO_ID];
  const params = { headers: Object.assign({}, conf.headers) };

  let body = conf.body;
  if (conf.bodyLoader) {
    body = conf.bodyLoader(data);
    if (!body) {
      // Defensive only: a real setup() fetch failure aborts the whole
      // test from inside setup() (see renderSetup), so this branch is
      // reachable only when setup() did not run at all, e.g. k6 run
      // --no-setup. Skip the POST rather than send a non-image body that
      // yields a misleading "unknown format" at the function.
      check(null, { 'payload image available': () => false });
      return;
    }
    params.headers['Content-Type'] = conf.contentType;
  }

  let res;
  switch (conf.method.toUpperCase()) {
    case 'GET':
      res = http.get(conf.url, params);
      break;
    case 'POST':
      res = http.post(conf.url, body, params);
      break;
    case 'PUT':
      res = http.put(conf.url, body, params);
      break;
    case 'DELETE':
      res = http.del(conf.url, body, params);
      break;
    default:
      res = http.get(conf.url, params);
  }

  if (res.status < 200 || res.status >= 300) {
    console.log('Request failed. URL: ' + conf.url + ' | Status: ' + res.status + ' | Body: ' + res.body);
  }

  check(res, {
    'status is 2xx': (r) => r.status >= 200 && r.status < 300,
  });
}

export function handleSummary(data) {
  // Ship the end-of-test summary to the DFaaS collector (SeaweedFS filer).
  // No-op when DFAAS_SUMMARY_URL is not injected (e.g. local runs).
  if (__ENV.DFAAS_SUMMARY_URL) {
    const res = http.put(__ENV.DFAAS_SUMMARY_URL, JSON.stringify(data), {
      headers: { 'Content-Type': 'application/json' },
      timeout: '30s',
    });
    if (res.status < 200 || res.status >= 300) {
      console.error('summary upload failed: status=' + res.status);
    }
  }
  // Defining handleSummary suppresses k6's default stdout summary; return the
  // raw JSON on stdout as a fallback for when the PUT fails. The operator keeps
  // only the first 256 KiB of the runner log, so a large summary gets cut.
  return { stdout: JSON.stringify(data, null, 1) };
}
`;
}
