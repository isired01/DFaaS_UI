// Self-check for lib/duration.js. No test framework in this repo, so this is a
// plain assert script: `node src/lib/duration.selfcheck.mjs`.
//
// It exists because a wrong total does not crash anything — it just parks the
// progress bar at the wrong percentage for the whole run.

import assert from 'node:assert/strict';
import { parseGoDuration, formatGoDuration, scenarioTotalMs, perNodeTotalMs } from './duration.js';

// --- parseGoDuration: the same grammar the CRD pattern accepts -------------
assert.equal(parseGoDuration('30s'), 30_000);
assert.equal(parseGoDuration('5m'), 300_000);
assert.equal(parseGoDuration('1h30m'), 5_400_000);
assert.equal(parseGoDuration('2m30s'), 150_000);
assert.equal(parseGoDuration('1.5s'), 1_500);
// "ms" must not be read as minutes — the reason the unit alternation is ordered
assert.equal(parseGoDuration('500ms'), 500);
assert.equal(parseGoDuration('  30s  '), 30_000);

// --- rejections: every one of these used to be a plausible wrong number ----
for (const bad of ['5 minutes', '', '30', '5min', '1h 30m', 'µs', '10S', 'abc', null, undefined, 42]) {
  assert.equal(parseGoDuration(bad), null, `expected null for ${JSON.stringify(bad)}`);
}

// --- formatGoDuration round-trips through the CRD grammar ------------------
for (const s of ['30s', '5m', '1h30m', '2m30s', '500ms']) {
  assert.equal(parseGoDuration(formatGoDuration(parseGoDuration(s))), parseGoDuration(s), `round-trip ${s}`);
}
assert.equal(formatGoDuration(0), '0s');
assert.equal(formatGoDuration(-1), '0s');
assert.equal(formatGoDuration(90_000), '1m30s');

// --- scenarioTotalMs: startTime offset plus every stage --------------------
assert.equal(scenarioTotalMs({ startTime: '0s', stages: [{ duration: '10s' }, { duration: '30s' }, { duration: '10s' }] }), 50_000);
assert.equal(scenarioTotalMs({ startTime: '1m', stages: [{ duration: '30s' }] }), 90_000);
assert.equal(scenarioTotalMs({ stages: [{ duration: '30s' }] }), 30_000, 'missing startTime defaults to 0s');
assert.equal(scenarioTotalMs({ startTime: '0s', stages: [{ duration: 'nope' }] }), null);
assert.equal(scenarioTotalMs({ startTime: 'nope', stages: [] }), null);

// --- perNodeTotalMs: scenarios overlap, so the node ends with the LAST one --
assert.equal(perNodeTotalMs([
  { startTime: '0s', stages: [{ duration: '1m' }] },
  { startTime: '30s', stages: [{ duration: '1m' }] }, // ends at 90s
]), 90_000, 'concurrent scenarios take max, not sum');
assert.equal(perNodeTotalMs([{ startTime: '0s', stages: [{ duration: '2m' }] }]), 120_000);
assert.equal(perNodeTotalMs([]), null);
assert.equal(perNodeTotalMs(null), null);
assert.equal(perNodeTotalMs([{ startTime: '0s', stages: [{ duration: 'x' }] }]), null, 'one bad scenario poisons the total');

// --- constant-arrival-rate: no stages, the total comes from `duration` ------
const car = (o) => ({ executor: 'constant-arrival-rate', ...o });
assert.equal(scenarioTotalMs(car({ startTime: '0s', duration: '2m' })), 120_000);
assert.equal(scenarioTotalMs(car({ startTime: '30s', duration: '1m' })), 90_000, 'startTime still offsets');
assert.equal(scenarioTotalMs(car({ duration: '45s' })), 45_000, 'missing startTime defaults to 0s');
assert.equal(scenarioTotalMs(car({ startTime: '0s', duration: '5 minutes' })), null, 'unparsable duration refuses');
assert.equal(scenarioTotalMs(car({ startTime: '0s' })), null, 'missing duration refuses rather than totalling 0');
// A stale stages array left over from switching executor must be ignored:
// reading it would return 10s instead of the real 2m and pin the bar at 100%.
assert.equal(
  scenarioTotalMs(car({ startTime: '0s', duration: '2m', stages: [{ duration: '10s' }] })),
  120_000,
  'stages are ignored for constant-arrival-rate',
);
// Mixed node: a ramping and a constant scenario still take the max.
assert.equal(perNodeTotalMs([
  { startTime: '0s', stages: [{ duration: '1m' }] },        // ends at 60s
  car({ startTime: '30s', duration: '2m' }),                 // ends at 150s
]), 150_000, 'max across mixed executors');

console.log('duration.js self-check: all assertions passed');
