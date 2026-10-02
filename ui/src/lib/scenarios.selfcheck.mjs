// Self-check for lib/scenarios.js: `node src/lib/scenarios.selfcheck.mjs`.
// The registry is the one place the executor shape lives; if it breaks, the
// generated script and the progress bar disagree silently.
import assert from 'node:assert/strict';
import {
  EXECUTORS, DEFAULT_EXECUTOR, executorOf, scenarioTotalMs, perNodeTotalMs,
  effectiveMethod, newScenario, ensureScenarioIds, validateScenarios,
  hasImage, relocatablePath, payloadPatch, NO_PAYLOAD,
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

// --- payload location: the path, the upload patch, the removal -------------
// The generated script prefers DFAAS_ASSET_BASE + payloadImagePath over the
// baked URL, so a path that is wrong but present fetches the wrong object
// while the test reports success. These pin when a path exists at all.
const PAYLOAD_KEYS = ['payloadContentType', 'payloadFilename', 'payloadImagePath', 'payloadImageURL'];
const keysOf = (o) => Object.keys(o).sort();

assert.equal(relocatablePath({ payloadImagePath: '/b/assets/a.png' }), '/b/assets/a.png');
for (const bad of [undefined, null, '', 'b/assets/a.png', 42, ['/b/k'], { p: '/b/k' }]) {
  assert.equal(relocatablePath({ payloadImagePath: bad }), null, `not an object path: ${JSON.stringify(bad)}`);
}
assert.equal(relocatablePath(undefined), null);
assert.equal(relocatablePath({ payloadImageURL: 'http://h:30900/b/assets/a.png' }), null, 'an old draft has only the baked URL');

const relRes = { url: 'http://10.0.0.1:30900/b/assets/a.png', contentType: 'image/png', filename: 'a.png', relocatable: true, path: '/b/assets/a.png' };
assert.deepEqual(payloadPatch(relRes), {
  payloadImageURL: relRes.url, payloadContentType: 'image/png', payloadFilename: 'a.png', payloadImagePath: '/b/assets/a.png',
});
// An external S3 config answers relocatable=false and no path.
const extRes = { url: 'https://s3.example.org/b/assets/a.png', contentType: 'image/png', filename: 'a.png', relocatable: false };
const extPatch = payloadPatch(extRes);
assert.deepEqual(keysOf(extPatch), PAYLOAD_KEYS, 'the patch must carry payloadImagePath even when it is cleared');
assert.equal(extPatch.payloadImagePath, undefined);
assert.equal(extPatch.payloadImageURL, extRes.url);
// The path is taken only on relocatable === true AND a leading-slash string.
for (const res of [
  { path: '/b/k' }, { relocatable: 'true', path: '/b/k' }, { relocatable: 1, path: '/b/k' },
  { relocatable: false, path: '/b/k' }, { relocatable: true }, { relocatable: true, path: 'b/k' }, { relocatable: true, path: 7 },
]) {
  const patch = payloadPatch({ url: 'http://h/b/k', ...res });
  assert.deepEqual(keysOf(patch), PAYLOAD_KEYS, `four keys for ${JSON.stringify(res)}`);
  assert.equal(patch.payloadImagePath, undefined, `no path for ${JSON.stringify(res)}`);
}
assert.deepEqual(keysOf(payloadPatch({})), PAYLOAD_KEYS);

// The stale-path regression: updateScenario merges {...s, ...patch}. Replacing
// a relocatable upload with a non-relocatable one must clear the old path, or
// every generator would fetch the PREVIOUS object, still in SeaweedFS.
const attached = {
  id: 'scn-x', name: 's', payloadImageURL: 'http://10.0.0.1:30900/b/assets/old.png',
  payloadImagePath: '/b/assets/old.png', payloadContentType: 'image/png', payloadFilename: 'old.png',
};
const replaced = { ...attached, ...extPatch };
assert.equal(relocatablePath(replaced), null, 'a non-relocatable replacement must drop the previous path');
assert.equal(replaced.payloadImageURL, extRes.url);
assert.equal(relocatablePath({ ...attached, ...payloadPatch(relRes) }), '/b/assets/a.png', 'a relocatable replacement carries its own path');

// NO_PAYLOAD clears the same four keys, so the draft forgets the path too.
assert.deepEqual(keysOf(NO_PAYLOAD), PAYLOAD_KEYS);
assert.ok(Object.isFrozen(NO_PAYLOAD), 'shared patch object: nobody may mutate it');
const removed = { ...attached, ...NO_PAYLOAD };
for (const k of PAYLOAD_KEYS) assert.equal(removed[k], undefined, `${k} cleared`);
assert.equal(hasImage(removed), false);
assert.deepEqual(keysOf(JSON.parse(JSON.stringify(removed))), ['id', 'name'], 'the localStorage draft drops every cleared key');

// Old drafts pass through ensureScenarioIds untouched: no path invented, an
// existing one kept.
const [oldDraft, relDraft] = ensureScenarioIds([
  { id: 'scn-1', name: 'old', executor: 'ramping-arrival-rate', payloadImageURL: 'http://10.0.0.1:30900/b/assets/a.png' },
  { id: 'scn-2', name: 'rel', executor: 'ramping-arrival-rate', payloadImageURL: 'http://10.0.0.1:30900/b/assets/a.png', payloadImagePath: '/b/assets/a.png' },
]);
assert.ok(!('payloadImagePath' in oldDraft), 'an old draft must not gain a path');
assert.equal(relocatablePath(oldDraft), null);
assert.equal(oldDraft.payloadImageURL, 'http://10.0.0.1:30900/b/assets/a.png');
assert.equal(relocatablePath(relDraft), '/b/assets/a.png');

// A path alone is not an image: hasImage and the POST coercion stay keyed on
// the baked URL, the mandatory fallback.
assert.equal(hasImage({ payloadImagePath: '/b/k' }), false);
assert.equal(effectiveMethod({ method: 'GET', payloadImagePath: '/b/k' }), 'GET');
assert.equal(effectiveMethod({ method: 'GET', ...payloadPatch(relRes) }), 'POST');

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
