// Self-check for lib/crstate.js. No test framework in this repo, so this is a
// plain assert script: `node src/lib/crstate.selfcheck.mjs`.
//
// crstate is the module extracted precisely to concentrate Phase and Condition
// knowledge, and it had no selfcheck -- so nothing noticed when LoadTestDetail
// re-listed the Scheduled reasons inline, re-decided their tones in raw
// Tailwind, and printed the raw camelCase identifier. The page showed
// "ScheduledDelayedEnvNotReady" while ConditionsList, on the same page, showed
// "Schedule fired, environment not ready".

import assert from 'node:assert/strict';
import {
  reason, isCurated, toneText, tonePanel, conditionOf, SCHEDULED_REASONS, phase,
} from './crstate.js';

// --- every reason the UI groups on must have a curated label ---------------
// This is the assertion that would have caught the divergence. A fourth
// Scheduled reason added operator-side and listed here without a label in
// REASONS fails the check instead of rendering as a raw identifier.
for (const r of SCHEDULED_REASONS) {
  assert.ok(isCurated(r), `${r} is grouped by the UI but has no curated label`);
  const { label, tone } = reason(r);
  assert.ok(label && label !== r, `${r} renders as its own identifier`);
  assert.ok(tone, `${r} has no tone`);
}

// The three the operator stamps today, with the tone each one must carry.
assert.deepEqual(reason('ScheduledArmed'), { label: 'Scheduled', tone: 'info' });
assert.deepEqual(reason('ScheduledFired'), { label: 'Schedule fired', tone: 'ok' });
assert.deepEqual(reason('ScheduledDelayedEnvNotReady'),
  { label: 'Schedule fired, environment not ready', tone: 'warn' });

// --- an unknown reason is humanised, never blank ---------------------------
// A reason the operator adds tomorrow must still render readably.
assert.deepEqual(reason('SomeBrandNewReason'), { label: 'Some Brand New Reason', tone: 'neutral' });
assert.equal(reason(undefined).tone, 'neutral');
assert.equal(reason('').label, '');

// --- every tone resolves to a class, in both forms ------------------------
for (const r of SCHEDULED_REASONS) {
  const { tone } = reason(r);
  assert.match(toneText(tone), /^text-/, `toneText(${tone}) is not a text class`);
  assert.match(tonePanel(tone), /^bg-.*border-.*text-/, `tonePanel(${tone}) is incomplete`);
}
assert.equal(toneText('nonsense'), toneText('neutral'), 'an unknown tone must fall back');
assert.equal(tonePanel('nonsense'), tonePanel('neutral'), 'an unknown tone must fall back');

// --- conditionOf is null-safe on a CR with no status yet -------------------
const conditions = [
  { type: 'Ready', reason: 'UserAborted', message: 'aborted from the UI' },
  { type: 'Scheduled', reason: 'ScheduledArmed', message: 'armed for 2026-01-01T00:00:00Z' },
];
assert.equal(conditionOf(undefined, 'Ready', ['UserAborted']), undefined);
assert.equal(conditionOf(null, 'Ready', ['UserAborted']), undefined);
assert.equal(conditionOf([], 'Ready', ['UserAborted']), undefined);
assert.equal(conditionOf(conditions, 'Ready', ['UserAborted']).message, 'aborted from the UI');
assert.equal(conditionOf(conditions, 'Scheduled', SCHEDULED_REASONS).reason, 'ScheduledArmed');
// The right type with a reason outside the group must not match: a Scheduled
// Condition stamped False for some other reason is not a schedule banner.
assert.equal(conditionOf(conditions, 'Scheduled', ['ScheduledFired']), undefined);
assert.equal(conditionOf(conditions, 'Ready', undefined).reason, 'UserAborted');

// --- an unmapped phase shows its own name, never "Unknown" for a real one --
assert.equal(phase('lt', 'Running').label, 'Running');
assert.equal(phase('lt', 'SomeFuturePhase').label, 'SomeFuturePhase');
assert.equal(phase('lt', '').label, 'Initializing');

console.log('crstate.js self-check: all assertions passed');
