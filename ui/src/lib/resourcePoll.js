// The read policy every polling page in the SPA needs, with no React in it, so
// that resourcePoll.selfcheck.mjs can drive it under plain node.
//
// Eight pages used to hand-roll this. Two of them carried the correct version
// and six carried one or both of these defects:
//
//   * the error was cleared at the START of a read, so on an unreachable
//     Management cluster a detail page flashed the message for one frame every
//     5 seconds and rendered nothing in between — a blank page;
//   * no in-flight guard and no AbortController, so reads piled up against a
//     slow cluster and a closed page kept reading.
//
// The contract, which the React binding and the selfcheck both rely on:
//   - one read in flight at a time; a second load() while one is running is
//     dropped, not queued;
//   - onData fires only on success. It is the ONLY success signal, so a caller
//     that clears its error there can never clear it too early;
//   - an aborted read is not an error: onError never sees it;
//   - only the newest read may release the guard. An aborted read settles after
//     its replacement has already started, so an unconditional release would
//     free the guard while a live read is still running;
//   - stop() releases the guard synchronously. abort() only rejects the fetch on
//     a later tick, so under StrictMode's mount/cleanup/mount the second mount
//     would otherwise find the guard taken and skip its own read — leaving the
//     page empty until the interval fired.
export function createPoll({ fetch, onData, onError, onSettled, shouldPoll }) {
  let inFlight = false;
  let current = null;
  let latest;
  let loaded = false;

  async function load() {
    if (inFlight) return;
    inFlight = true;
    const controller = new AbortController();
    current = controller;
    try {
      const data = await fetch({ signal: controller.signal });
      latest = data;
      loaded = true;
      onData?.(data);
    } catch (err) {
      if (err?.name !== 'AbortError') onError?.(err);
    } finally {
      if (current === controller) {
        inFlight = false;
        onSettled?.();
      }
    }
  }

  // One interval tick. Before the first successful read the predicate is not
  // consulted at all: it is written against the resource, which does not exist
  // yet (LoadTestDetail polls while the LoadTest Phase is in flight, and a
  // missing LoadTest has no Phase).
  function tick() {
    if (!loaded || !shouldPoll || shouldPoll(latest)) return load();
    return undefined;
  }

  function stop() {
    current?.abort();
    current = null;
    inFlight = false;
  }

  return { load, tick, stop };
}
