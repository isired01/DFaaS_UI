// Cluster reachability, derived from real API traffic rather than guessed.
//
// The header badge used to be hardcoded to "Cluster Connected", so it stayed
// green while every request was failing — the single most misleading thing the
// UI could say. Rather than adding a dedicated health poll (more traffic, and
// still only a proxy for what the user cares about), status is reported by the
// one choke point every call already goes through: `request()` in api/client.js.
// If real calls are succeeding we are connected; if they fail at the network
// layer or the gateway reports it cannot reach the cluster, we are not.
//
// Backs a `useSyncExternalStore` subscription — no state library needed.

const UNKNOWN = 'unknown';
const OK = 'ok';
const DOWN = 'down';

let status = UNKNOWN;
const listeners = new Set();

function set(next) {
  if (next === status) return; // no-op keeps useSyncExternalStore from re-rendering
  status = next;
  listeners.forEach(fn => fn());
}

// A completed request — any HTTP answer, even 4xx — proves the gateway is up.
// Only a gateway that says it cannot reach Kubernetes counts as "down".
export function reportApiResponse(httpStatus) {
  set(httpStatus === 503 ? DOWN : OK);
}

// The fetch itself rejected: gateway unreachable, DNS failure, connection
// refused, or the request was aborted mid-flight by a page teardown. Aborts are
// routine, so callers pass `aborted` to avoid flapping the badge red.
export function reportApiFailure({ aborted = false } = {}) {
  if (aborted) return;
  set(DOWN);
}

// A gateway 5xx caused by an unreachable cluster (the k8s call timed out rather
// than the client being nil) — reported explicitly by request() so a genuine
// application-level 500 does not get mistaken for a dead cluster.
export function reportClusterUnreachable() {
  set(DOWN);
}

export function subscribeClusterStatus(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getClusterStatus() {
  return status;
}
