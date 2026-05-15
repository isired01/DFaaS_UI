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

function renderConfig(s) {
  const headers = s.headers && s.headers.trim() ? s.headers.trim() : '{}';
  const body = s.body ? jsString(s.body) : 'null';
  return `  "${s.name}": {
    method: '${s.method || 'GET'}',
    url: '${s.targetURL || ''}',
    body: ${body},
    headers: ${headers},
  },`;
}

export function generateK6Script(scenarios) {
  if (!scenarios || scenarios.length === 0) return '';

  const scenariosBlock = scenarios.map(renderScenario).join('\n');
  const configBlock = scenarios.map(renderConfig).join('\n');

  return `import http from 'k6/http';
import { check } from 'k6';

export const options = {
  scenarios: {
${scenariosBlock}
  },
};

const scenarioConfig = {
${configBlock}
};

export function runScenario() {
  const conf = scenarioConfig[__ENV.SCENARIO_ID];
  const params = { headers: conf.headers };

  let res;
  switch (conf.method.toUpperCase()) {
    case 'GET':
      res = http.get(conf.url, params);
      break;
    case 'POST':
      res = http.post(conf.url, conf.body, params);
      break;
    case 'PUT':
      res = http.put(conf.url, conf.body, params);
      break;
    case 'DELETE':
      res = http.del(conf.url, conf.body, params);
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
