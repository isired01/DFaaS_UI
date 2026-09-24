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
  reason, isCurated, toneText, tonePanel, conditionOf, SCHEDULED_REASONS, phase, lt,
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
// The table key is 'loadtest': 'lt' used to fall back to the Environment table,
// which left the LoadTest phase table without any coverage.
assert.equal(phase('loadtest', 'Running').label, 'Running');
assert.equal(phase('loadtest', 'SomeFuturePhase').label, 'SomeFuturePhase');
assert.equal(phase('loadtest', '').label, 'Pending', "a LoadTest not yet admitted reads Pending");
assert.equal(phase('loadtest', 'Failed').tone, 'error');
assert.equal(phase('env', '').label, 'Initializing');

// --- every operator reason meaning *dead* must carry tone 'error' ----------
// ProvisioningConditionRow decides spinner-vs-error solely from
// reason(r).tone === 'error'. A terminal reason that is missing from REASONS,
// or curated with any other tone, therefore renders as the in-progress
// spinner FOREVER on a genuinely failed Environment -- no error, no end. This
// used to be a hand-kept FAILED_REASONS list in that component, which is
// worse only in that it was somewhere nobody looked. Add a terminal reason
// operator-side, add it here.
//
// The list is the operator's own classification: the `true` rows of
// terminalFailure in DFaaSOperator/api/v1/inventory_test.go.
for (const r of ['AnsibleFailed', 'HelmFailed', 'InfraFailed', 'Failed', 'DispatchFailed', 'PartialFailure',
  'AllFailed', 'JobFailed', 'SyncTimeout', 'S3ConfigMissing', 'EnvNotFound']) {
  assert.equal(reason(r).tone, 'error',
    `${r} means the object failed for good; without tone 'error' the provisioning row spins forever`);
}
// Retried without bound and shown on a provisioning row: the operator keeps
// trying, but nothing will change until a human acts, so these stay red --
// 'warn' would bring back the forever-spinner 293bf21 removed.
for (const r of ['CheckFailed', 'JobCreationFailed']) {
  assert.equal(reason(r).tone, 'error', `${r} needs a human; a spinner would never stop`);
}
// ...while a reason the operator keeps retrying on its own must not claim the
// object is dead.
for (const r of ['RunnersUnreclaimed', 'FetchFailed', 'ApplyFailed', 'StaleCleanupFailed', 'ScriptMirrorFailed']) {
  assert.notEqual(reason(r).tone, 'error', `${r} is retried by the operator; it must not render as dead`);
}

// --- Occupancy and Delete ---------------------------------------------------
// The gateway's node-edit guard counts a non-suspended test the operator has
// not admitted yet (""), and so must the SPA.
assert.equal(lt.occupying({ phase: '', suspended: false }), true);
assert.equal(lt.occupying({ phase: '', suspended: true }), false);
// A terminal test whose runners the operator could not delete still holds the
// Environment (operator runnersUnreclaimed, gateway activeLoadTestNames).
assert.equal(lt.occupying({ phase: 'Aborted', runnersUnreclaimed: true }), true);
assert.equal(lt.occupying({ phase: 'Completed' }), false);
// Deleting a running or exporting test throws away the run or its export.
for (const p of ['Running', 'Exporting']) assert.equal(lt.deletable(p), false, `${p} is not deletable`);
for (const p of ['', 'Pending', 'Completed', 'Failed', 'Aborted']) assert.equal(lt.deletable(p), true, `${p} is deletable`);

console.log('crstate.js self-check: all assertions passed');
