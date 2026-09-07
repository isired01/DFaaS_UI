// Go-duration parse/format. The scenario-level totals that drive the progress
// bar live in lib/scenarios.js next to each executor's option block, so the
// emitted script and the computed runtime cannot drift.
//
// Self-check: `node src/lib/duration.selfcheck.mjs`

const UNIT_MS = { ns: 1e-6, us: 1e-3, ms: 1, s: 1000, m: 60000, h: 3600000 };

// Matches one <number><unit> pair. Order matters: "ns"/"us"/"ms" must be tried
// before the bare "s"/"m", otherwise "500ms" would parse as 500 minutes.
const PAIR_RE = /([0-9]+(?:\.[0-9]+)?)(ns|us|ms|s|m|h)/g;

// parseGoDuration returns milliseconds, or null when the input is not a valid
// Go duration. Deliberately strict and anchored: a partial match ("1h 30m",
// "10S", "30") returns null rather than a plausible-looking wrong number,
// because a wrong total would silently hold the progress bar at the wrong
// percentage for the whole run.
export function parseGoDuration(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (!s) return null;

  PAIR_RE.lastIndex = 0;
  let total = 0;
  let consumed = 0;
  let m;
  while ((m = PAIR_RE.exec(s)) !== null) {
    if (m.index !== consumed) return null; // gap between pairs
    total += parseFloat(m[1]) * UNIT_MS[m[2]];
    consumed = PAIR_RE.lastIndex;
  }
  if (consumed === 0 || consumed !== s.length) return null;
  return total;
}

// formatGoDuration renders milliseconds back into the CRD's grammar. Used to
// write the derived total into spec.perNodeLoad[].duration on submit.
export function formatGoDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  let rest = Math.round(ms);
  const h = Math.floor(rest / 3600000); rest -= h * 3600000;
  const m = Math.floor(rest / 60000); rest -= m * 60000;
  const s = Math.floor(rest / 1000); rest -= s * 1000;
  let out = '';
  if (h) out += `${h}h`;
  if (m) out += `${m}m`;
  if (s) out += `${s}s`;
  if (rest) out += `${rest}ms`;
  return out || '0s';
}
