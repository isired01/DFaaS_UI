// k6 script generator. Pure function: scenarios -> JS script string.
// Mirrors the layout previously rendered by internal/api/k6_generator.go.
// The LoadTest CRD's spec.perNodeLoad[].vus and .duration drive the runner;
// scenario-level VU options are intentionally omitted here.

function jsString(s) {
  return JSON.stringify(s ?? '');
}

function renderScenario(s) {
  const stages = (s.stages || []).map(st => `        { duration: '${st.duration}', target: ${st.target} },`).join('\n');
  return `    "${s.name}": {
      executor: '${s.executor || 'ramping-arrival-rate'}',
      startRate: 0,
      timeUnit: '1s',
      preAllocatedVUs: ${s.preAllocatedVUs || 10},
      maxVUs: ${s.maxVUs || 50},
      startTime: '${s.startTime || '0s'}',
      stages: [
${stages}
      ],
      exec: 'runScenario',
      env: { SCENARIO_ID: '${s.name}' },
    },`;
}

// hasImage reports whether a scenario carries an uploaded payload to use as the
// request body (instead of the free-text body).
function hasImage(s) {
  return !!(s && s.payloadImageURL);
}

// effectiveMethod forces POST when a scenario has an image but is configured as
// GET — a GET cannot carry a binary body in k6.
function effectiveMethod(s) {
  const m = (s.method || 'GET').toUpperCase();
  if (hasImage(s) && (m === 'GET' || m === 'DELETE')) return 'POST';
  return m;
}

function renderConfig(s, idx) {
  const headers = s.headers && s.headers.trim() ? s.headers.trim() : '{}';
  const method = effectiveMethod(s);
  if (hasImage(s)) {
    // Body bytes are fetched ONCE in setup() and handed to each VU as base64;
    // __getImg_<idx>(data) decodes them per VU. The config exposes the loader +
    // content type so the request builder can attach both.
    return `  "${s.name}": {
    method: '${method}',
    url: '${s.targetURL || ''}',
    bodyLoader: __getImg_${idx},
    contentType: ${jsString(s.payloadContentType || 'application/octet-stream')},
    headers: ${headers},
  },`;
  }
  const body = s.body ? jsString(s.body) : 'null';
  return `  "${s.name}": {
    method: '${method}',
    url: '${s.targetURL || ''}',
    body: ${body},
    headers: ${headers},
  },`;
}

// renderSetup emits the once-per-test setup() that fetches every image payload
// a SINGLE time and base64-encodes it. k6 forbids HTTP in the init context and
// runs setup() exactly once, so this is what turns N fetches (one per VU) into
// one fetch total — the object store is hit once regardless of VU count. Binary
// can't survive setup-data JSON serialization to the VUs, hence base64.
function renderSetup(imageScenarios) {
  const fetches = imageScenarios.map(s =>
`  {
    const __r = http.get(${jsString(s.payloadImageURL)}, { responseType: 'binary' });
    if (__r.status === 200 && __r.body && __r.body.byteLength > 0) {
      payloads[${jsString(s.name)}] = encoding.b64encode(__r.body);
    } else {
      console.log('setup: payload fetch failed for ' + ${jsString(s.name)} + ' (status=' + __r.status + ')');
    }
  }`).join('\n');
  return `export function setup() {
  const payloads = {};
${fetches}
  return { payloads };
}`;
}

// renderImageDecoder emits a per-VU lazy decode of the payload that setup()
// fetched once and passed in as base64. Decoded to an ArrayBuffer once per VU;
// null when setup's fetch failed (the caller then skips the POST rather than
// sending a non-image body — which would surface as a misleading
// "unknown format" at the function).
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

  const imageScenarios = scenarios.filter(hasImage);
  const anyImage = imageScenarios.length > 0;

  const scenariosBlock = scenarios.map(renderScenario).join('\n');
  const configBlock = scenarios.map((s, i) => renderConfig(s, i)).join('\n');
  const decoderBlock = scenarios
    .map((s, i) => (hasImage(s) ? renderImageDecoder(s, i) : null))
    .filter(Boolean)
    .join('\n\n');
  const setupBlock = anyImage ? renderSetup(imageScenarios) : '';

  return `import http from 'k6/http';
import { check } from 'k6';${anyImage ? `\nimport encoding from 'k6/encoding';` : ''}

export const options = {
  scenarios: {
${scenariosBlock}
  },
};
${anyImage ? `\n${setupBlock}\n` : ''}${decoderBlock ? `\n${decoderBlock}\n` : ''}
const scenarioConfig = {
${configBlock}
};

export function runScenario(data) {
  const conf = scenarioConfig[__ENV.SCENARIO_ID];
  const params = { headers: Object.assign({}, conf.headers) };

  let body = conf.body;
  if (conf.bodyLoader) {
    body = conf.bodyLoader(data);
    if (!body) {
      // Payload missing (setup's fetch failed). Skip the POST rather than send a
      // non-image body that yields a misleading "unknown format" at the function.
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
`;
}
