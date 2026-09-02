// Go-duration helpers.
//
// The CRD validates spec.perNodeLoad[].duration against
// ^([0-9]+(\.[0-9]+)?(ns|us|ms|s|m|h))+$ — but nothing ever checked that the
// value matched what the script actually does, because the operator only
// copies it onto an annotation nobody reads. These helpers let the form derive
// a node's real runtime from its k6 scenario stages, so the field stops being
// decorative and can drive the per-generator progress bar.
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

// scenarioTotalMs is how long one scenario runs from t=0 of the test: its
// startTime offset plus every stage, which k6 walks in order. null when any
// piece is unparsable.
export function scenarioTotalMs(scen) {
  const start = parseGoDuration(scen?.startTime || '0s');
  if (start === null) return null;
  let sum = 0;
  for (const st of scen?.stages || []) {
    const d = parseGoDuration(st?.duration);
    if (d === null) return null;
    sum += d;
  }
  return start + sum;
}

// perNodeTotalMs is the runtime of a whole generator: scenarios run
// concurrently, each offset by its own startTime, so the node stays busy until
// the LAST one ends — hence max, not sum. null when any scenario is
// unparsable, so callers can refuse rather than guess.
export function perNodeTotalMs(scenarios) {
  const list = scenarios || [];
  if (list.length === 0) return null;
  let max = 0;
  for (const scen of list) {
    const t = scenarioTotalMs(scen);
    if (t === null) return null;
    if (t > max) max = t;
  }
  return max;
}
