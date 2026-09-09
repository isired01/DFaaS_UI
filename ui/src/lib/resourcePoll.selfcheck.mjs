// Self-check for lib/resourcePoll.js. No test framework in this repo, so this is
// a plain assert script: `node src/lib/resourcePoll.selfcheck.mjs`.
//
// Every assertion here is a defect that shipped in at least one page: reads
// piling up against a slow Management cluster, an error message wiped before it
// could be read, and an abort on unmount reported to the user as a failure.

import assert from 'node:assert/strict';
import { createPoll } from './resourcePoll.js';

// A page, modelled the way every call site behaves: it clears its error on
// success and on nothing else.
function page(fetch, shouldPoll) {
  const state = { data: null, error: null, loading: true, settled: 0 };
  const poll = createPoll({
    fetch,
    onData: (d) => { state.data = d; state.error = null; },
    onError: (err) => { state.error = err.message; },
    onSettled: () => { state.loading = false; state.settled += 1; },
    shouldPoll,
  });
  return { state, poll };
}

const never = () => new Promise(() => {});
const flush = () => new Promise((r) => setImmediate(r));

// --- one read in flight at a time ------------------------------------------
{
  let calls = 0;
  const { poll } = page(() => { calls += 1; return never(); });
  poll.load();
  poll.load();
  poll.load();
  await flush();
  assert.equal(calls, 1, 'an overlapping read must be dropped, not queued');
}

// --- the error survives every subsequent failed read ----------------------
{
  const { state, poll } = page(() => Promise.reject(new Error('management cluster unreachable')));
  await poll.load();
  assert.equal(state.error, 'management cluster unreachable');
  for (let i = 0; i < 5; i += 1) await poll.tick();
  assert.equal(state.error, 'management cluster unreachable', 'the message must stay readable across polls');
  assert.equal(state.loading, false, 'a failed first read must still stop the spinner');
}

// --- and is cleared by a success, not by the start of a read --------------
{
  let fail = true;
  const { state, poll } = page(() => (fail ? Promise.reject(new Error('boom')) : Promise.resolve({ phase: 'Ready' })));
  await poll.load();
  assert.equal(state.error, 'boom');
  fail = false;
  await poll.load();
  assert.equal(state.error, null, 'a success clears the error');
  assert.deepEqual(state.data, { phase: 'Ready' });
}

// --- an abort is not an error ---------------------------------------------
{
  const { state, poll } = page(({ signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => {
      const err = new Error('The operation was aborted.');
      err.name = 'AbortError';
      reject(err);
    });
  }));
  const inflight = poll.load();
  poll.stop();
  await inflight;
  assert.equal(state.error, null, 'unmounting a page must not show the user an error');
}

// --- stop() releases the guard synchronously (StrictMode's second mount) ---
{
  let calls = 0;
  const { poll } = page(({ signal }) => {
    calls += 1;
    return new Promise((_, reject) => {
      signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  });
  poll.load();
  poll.stop();
  poll.load(); // the second mount, on the same tick
  await flush();
  assert.equal(calls, 2, 'the second mount must read immediately, not wait out the interval');
}

// --- only the newest read may release the guard ---------------------------
{
  // The aborted read settles after its replacement has started. If it released
  // the guard, the next tick would start a third read alongside the live one.
  let calls = 0;
  let releaseSecond;
  const { poll } = page(({ signal }) => {
    calls += 1;
    if (calls === 1) {
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    }
    return new Promise((resolve) => { releaseSecond = () => resolve({ ok: true }); });
  });
  poll.load();
  poll.stop();
  poll.load();
  await flush();
  assert.equal(calls, 2);
  poll.load();
  await flush();
  assert.equal(calls, 2, 'the aborted read must not have freed the guard');
  releaseSecond();
  await flush();
  poll.load();
  await flush();
  assert.equal(calls, 3, 'once the live read settles the guard is free again');
}

// --- shouldPoll gates the interval, never the first read ------------------
{
  let calls = 0;
  // The predicate LoadTestDetail passes: keep polling while the Phase is in
  // flight. Before the first read there is no LoadTest and no Phase, so the
  // predicate must not be consulted — it would throw on null.
  const { state, poll } = page(
    () => { calls += 1; return Promise.resolve({ phase: 'Completed' }); },
    (lt) => lt.phase !== 'Completed',
  );
  await poll.tick();
  assert.equal(calls, 1, 'the first read must run even though no data exists yet');
  assert.deepEqual(state.data, { phase: 'Completed' });
  await poll.tick();
  await poll.tick();
  assert.equal(calls, 1, 'a terminal resource must stop being polled');
}
{
  let calls = 0;
  const { poll } = page(
    () => { calls += 1; return Promise.resolve({ phase: 'Running' }); },
    (lt) => lt.phase !== 'Completed',
  );
  await poll.tick();
  await poll.tick();
  assert.equal(calls, 2, 'an in-flight resource keeps being polled');
}

console.log('resourcePoll.js self-check: all assertions passed');
