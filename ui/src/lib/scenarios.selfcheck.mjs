// Self-check for lib/scenarios.js: `node src/lib/scenarios.selfcheck.mjs`.
// The registry is the one place the executor shape lives; if it breaks, the
// generated script and the progress bar disagree silently.
import assert from 'node:assert/strict';
import {
  EXECUTORS, DEFAULT_EXECUTOR, executorOf, scenarioTotalMs, perNodeTotalMs,
  effectiveMethod, newScenario, ensureScenarioIds, validateScenarios,
} from './scenarios.js';

const ok = (o = {}) => ({ name: 's', executor: 'ramping-arrival-rate', targetURL: 'http://x', preAllocatedVUs: 1, maxVUs: 1, startTime: '0s',
  stages: [{ duration: '10s', target: 1 }], ...o });

// --- registry shape ---------------------------------------------------------
assert.deepEqual(Object.keys(EXECUTORS).sort(), ['constant-arrival-rate', 'ramping-arrival-rate']);
for (const [k, e] of Object.entries(EXECUTORS)) {
  for (const fn of ['renderOptions', 'durationMs', 'validate']) assert.equal(typeof e[fn], 'function', `${k}.${fn}`);
  assert.ok(e.label && e.fields && e.defaults, `${k} label/fields/defaults`);
}
assert.equal(executorOf({ executor: 'shared-iterations' }), EXECUTORS[DEFAULT_EXECUTOR], 'unknown executor → default');
assert.equal(executorOf(undefined), EXECUTORS[DEFAULT_EXECUTOR]);

// --- each executor renders only its own options -----------------------------
const ramp = EXECUTORS['ramping-arrival-rate'].renderOptions(ok());
assert.match(ramp, /startRate: 0/); assert.match(ramp, /stages: \[/); assert.doesNotMatch(ramp, /\brate:/);
const flat = EXECUTORS['constant-arrival-rate'].renderOptions({ rate: 7, duration: '2m' });
assert.match(flat, /rate: 7/); assert.match(flat, /duration: "2m"/); assert.doesNotMatch(flat, /stages/);

// --- totals agree with what is rendered -------------------------------------
assert.equal(scenarioTotalMs(ok({ startTime: '30s', stages: [{ duration: '1m' }] })), 90_000);
assert.equal(scenarioTotalMs({ executor: 'constant-arrival-rate', startTime: '0s', duration: '2m', stages: [{ duration: '10s' }] }), 120_000, 'stale stages ignored');
assert.equal(perNodeTotalMs([ok({ stages: [{ duration: '1m' }] }), ok({ startTime: '30s', stages: [{ duration: '1m' }] })]), 90_000);
assert.equal(perNodeTotalMs([]), null);

// --- method coercion is visible, not silent --------------------------------
assert.equal(effectiveMethod({ method: 'GET' }), 'GET');
assert.equal(effectiveMethod({ method: 'GET', payloadImageURL: 'http://img' }), 'POST');
assert.equal(effectiveMethod({ method: 'DELETE', payloadImageURL: 'http://img' }), 'POST');
assert.equal(effectiveMethod({ method: 'PUT', payloadImageURL: 'http://img' }), 'PUT');

// --- identity: names never collide, defaults for every executor present ----
const a = newScenario([]); const b = newScenario([a]);
assert.notEqual(a.name, b.name); assert.notEqual(a.id, b.id);
assert.ok(Array.isArray(a.stages) && a.rate !== undefined && a.duration !== undefined, 'defaults of both executors carried');
const [fixed] = ensureScenarioIds([{ name: 'old', executor: 'ramping-vus' }]);
assert.ok(fixed.id, 'id backfilled'); assert.equal(fixed.executor, DEFAULT_EXECUTOR, 'VU executor coerced'); assert.equal(fixed.rate, 10);

// --- validation: returns errors, never throws -------------------------------
assert.deepEqual(validateScenarios([ok()]), []);
assert.match(validateScenarios([])[0], /at least one/);
assert.match(validateScenarios([ok({ name: 'a' }), ok({ name: 'a' })]).join(' '), /two scenarios named 'a'/);
assert.match(validateScenarios([ok({ name: '' })]).join(' '), /empty name/);
assert.match(validateScenarios([ok({ targetURL: '' })]).join(' '), /targetURL/);
assert.match(validateScenarios([ok({ maxVUs: 0 })]).join(' '), /maxVUs/);
assert.match(validateScenarios([ok({ headers: '[]' })]).join(' '), /headers must be a JSON object/);
assert.match(validateScenarios([ok({ headers: 'not json' })]).join(' '), /headers must be a JSON object/);
assert.deepEqual(validateScenarios([ok({ headers: '{"a":"b"}' })]), []);
assert.match(validateScenarios([ok({ stages: [{ duration: '5 minutes', target: 1 }] })]).join(' '), /stage 1: duration/);
assert.match(validateScenarios([{ ...ok(), executor: 'constant-arrival-rate', rate: 0, duration: '1m' }]).join(' '), /rate must be > 0/);

console.log('scenarios.js self-check: all assertions passed');
