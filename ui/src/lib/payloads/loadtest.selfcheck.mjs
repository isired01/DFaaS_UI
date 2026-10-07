// Self-check for lib/payloads/loadtest.js: `node src/lib/payloads/loadtest.selfcheck.mjs`.
// Every rule handleSubmit used to enforce with a throw, as a table.
import assert from 'node:assert/strict';
import { buildLoadTestPayload, SOURCE_GENERATE, SOURCE_RAW } from './loadtest.js';

// Mirrors GET /api/meta/schema .loadTest (internal/api/schema.go).
const rules = {
  goDurationPattern: '^([0-9]+(\\.[0-9]+)?(ns|us|ms|s|m|h))+$',
  minVUs: 1,
  metricTypes: [{ value: 'raw' }, { value: 'custom-promql' }],
};
const scen = { name: 's1', executor: 'ramping-arrival-rate', targetURL: 'http://fn', preAllocatedVUs: 5, maxVUs: 10, startTime: '0s',
  stages: [{ duration: '30s', target: 5 }], headers: '{}' };
const good = () => ({
  namespace: 'default', envName: 'env', step: '15s', nameSuffix: '', syncStart: false, submitMode: 'draft',
  metrics: [{ type: 'raw', query: 'up' }],
  perNode: { 'gen-a': { enabled: true, vus: 2, source: SOURCE_GENERATE, scenarios: [scen] } },
});
const errorsOf = (mutate) => { const d = good(); mutate(d); return buildLoadTestPayload(d, rules).errors; };

// --- the happy path: shape the gateway binds -------------------------------
{
  const { payload, errors, warnings } = buildLoadTestPayload(good(), rules);
  assert.deepEqual(errors, []); assert.deepEqual(warnings, []);
  assert.equal(payload.targetEnvironment, 'env'); assert.equal(payload.suspended, true);
  assert.equal(payload.perNodeLoad.length, 1);
  const pn = payload.perNodeLoad[0];
  assert.equal(pn.nodeID, 'gen-a'); assert.equal(pn.vus, 1, 'vus is fixed at the CRD minimum; the draft value is ignored');
  assert.equal(pn.duration, '30s', 'duration derived from the stages');
  assert.match(pn.script, /executor: 'ramping-arrival-rate'/, 'script generated');
  assert.deepEqual(payload.metricsExport, { metrics: [{ type: 'raw', query: 'up' }], step: '15s' });
  assert.equal(payload.startAt, undefined); assert.equal(payload.nameSuffix, undefined);
}

// --- an uploaded payload's path reaches the generated script ---------------
// The scenario goes through the builder as-is, so a relocatable upload lands in
// the script as a DFAAS_ASSET_BASE fetch and a path-less one does not.
{
  const img = { payloadImageURL: 'http://10.0.0.1:30900/b/assets/a.png', payloadContentType: 'image/png' };
  const d = good(); d.perNode['gen-a'].scenarios = [{ ...scen, ...img, payloadImagePath: '/b/assets/a.png' }];
  const { payload, errors } = buildLoadTestPayload(d, rules);
  assert.deepEqual(errors, []);
  assert.match(payload.perNodeLoad[0].script, /__ENV\.DFAAS_ASSET_BASE/, 'a relocatable image is fetched over DFAAS_ASSET_BASE');
  assert.ok(payload.perNodeLoad[0].script.includes('"/b/assets/a.png"'), 'the object path is in the script');
  const p = good(); p.perNode['gen-a'].scenarios = [{ ...scen, ...img }];
  assert.doesNotMatch(buildLoadTestPayload(p, rules).payload.perNodeLoad[0].script, /DFAAS_ASSET_BASE/, 'a path-less image keeps the baked URL only');
}

// --- raw source: typed duration must match the CRD pattern ------------------
{
  const d = good(); d.perNode['gen-a'] = { enabled: true, vus: 1, source: SOURCE_RAW, rawScript: 'export default function(){}', duration: '5m' };
  const { payload, errors } = buildLoadTestPayload(d, rules);
  assert.deepEqual(errors, []); assert.equal(payload.perNodeLoad[0].duration, '5m'); assert.match(payload.perNodeLoad[0].script, /export default/);
}
assert.match(errorsOf((d) => { d.perNode['gen-a'] = { enabled: true, vus: 1, source: SOURCE_RAW, rawScript: 'x', duration: '5 minutes' }; }).join(' '), /Go duration/);
assert.match(errorsOf((d) => { d.perNode['gen-a'] = { enabled: true, vus: 1, source: SOURCE_RAW, rawScript: '  ', duration: '5m' }; }).join(' '), /no raw script/);

// --- every error class, none thrown ---------------------------------------
assert.match(errorsOf((d) => { d.metrics = []; }).join(' '), /At least one metric/);
assert.match(errorsOf((d) => { d.metrics = [{ type: 'bogus', query: 'up' }]; }).join(' '), /invalid type/);
assert.match(errorsOf((d) => { d.metrics = [{ type: 'custom-promql', query: 'up' }]; }).join(' '), /metric name is required/);
assert.match(errorsOf((d) => { d.perNode['gen-a'].scenarios = [{ ...scen, targetURL: '' }]; }).join(' '), /targetURL/);
assert.match(errorsOf((d) => { d.perNode['gen-a'].scenarios = [scen, scen]; }).join(' '), /two scenarios named/);
assert.match(errorsOf((d) => { d.perNode['gen-a'].enabled = false; }).join(' '), /Enable at least one k6 node/);
assert.match(errorsOf((d) => { d.submitMode = 'schedule'; d.startAt = ''; }).join(' '), /Pick a start time/);
assert.match(errorsOf((d) => { d.submitMode = 'schedule'; d.startAt = 'yesterday'; }).join(' '), /not a valid timestamp/);
assert.match(errorsOf((d) => { d.submitMode = 'schedule'; d.startAt = '2000-01-01T00:00:00Z'; }).join(' '), /must be in the future/);
{
  const d = good(); d.submitMode = 'schedule'; d.startAt = '2999-01-01T00:00:00Z'; d.nameSuffix = ' trial ';
  const { payload, errors } = buildLoadTestPayload(d, rules);
  assert.deepEqual(errors, []); assert.equal(payload.startAt, '2999-01-01T00:00:00.000Z'); assert.equal(payload.nameSuffix, 'trial');
}
// duplicate metric names warn, never block
{
  const d = good(); d.metrics = [{ type: 'custom-promql', metricName: 'm', query: 'a' }, { type: 'custom-promql', metricName: 'm', query: 'b' }];
  const { errors, warnings } = buildLoadTestPayload(d, rules);
  assert.deepEqual(errors, []); assert.match(warnings[0], /duplicate metricName/);
}
console.log('payloads/loadtest.js self-check: all assertions passed');
