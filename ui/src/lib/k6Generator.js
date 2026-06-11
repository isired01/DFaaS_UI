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
    // Body bytes are fetched lazily at exec time and cached per VU via
    // __getImg_<idx>(); the config exposes the loader + content type so the
    // request builder can attach both.
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

// renderImageCache emits a module-scope lazy cache for a scenario's payload.
// The http.get MUST run inside the exec function (k6 forbids HTTP in the init
// context); the module-scope var memoizes the fetch to one call per VU.
function renderImageCache(s, idx) {
  return `let __img_${idx} = null;
function __getImg_${idx}() {
  if (__img_${idx} === null) {
    __img_${idx} = http.get(${jsString(s.payloadImageURL)}, { responseType: 'binary' }).body;
  }
  return __img_${idx};
}`;
}

export function generateK6Script(scenarios) {
  if (!scenarios || scenarios.length === 0) return '';

  const scenariosBlock = scenarios.map(renderScenario).join('\n');
  const configBlock = scenarios.map((s, i) => renderConfig(s, i)).join('\n');
  const imageCacheBlock = scenarios
    .map((s, i) => (hasImage(s) ? renderImageCache(s, i) : null))
    .filter(Boolean)
    .join('\n\n');

  return `import http from 'k6/http';
import { check } from 'k6';

export const options = {
  scenarios: {
${scenariosBlock}
  },
};
${imageCacheBlock ? `\n${imageCacheBlock}\n` : ''}
const scenarioConfig = {
${configBlock}
};

export function runScenario() {
  const conf = scenarioConfig[__ENV.SCENARIO_ID];
  const params = { headers: Object.assign({}, conf.headers) };

  let body = conf.body;
  if (conf.bodyLoader) {
    body = conf.bodyLoader();
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
