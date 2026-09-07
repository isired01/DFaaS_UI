// The k6 scenario shape, owned once.
//
// One entry per executor holds everything that used to be spread over four
// files and held together by "change one, change the other" comments: the
// option fragment the script emitter renders, how long the scenario runs (for
// the progress bar), which fields the editor shows, and the defaults. Adding an
// executor is one entry here plus whatever new form fields it needs.
//
// Pure: no React, no DOM, so lib/payloads and the selfcheck scripts can use it.

import { parseGoDuration } from './duration.js';

// jsString emits a safely quoted JS literal. EVERY user-supplied value spliced
// into the script must go through it: an apostrophe in an otherwise valid URL
// (e.g. ?q=O'Brien) closes a single-quoted literal early and the breakage only
// surfaces when remote k6 parses the script.
export const jsString = (s) => JSON.stringify(s ?? '');

// Option sets are NOT interchangeable between executors: k6 validates them and
// rejects missing or unknown keys, and that rejection lands on the remote runner
// after dispatch, where nobody sees it. So each executor emits exactly its own.
export const EXECUTORS = {
  'ramping-arrival-rate': {
    label: 'Ramping Arrival Rate',
    // Which editor section applies: the rate ramps through `stages`.
    fields: 'stages',
    defaults: {
      stages: [
        { duration: '10s', target: 10 },
        { duration: '30s', target: 10 },
        { duration: '10s', target: 0 },
      ],
    },
    renderOptions: (s) => {
      const stages = (s.stages || [])
        .map((st) => `        { duration: ${jsString(st.duration)}, target: ${st.target} },`)
        .join('\n');
      return `      startRate: 0,\n      stages: [\n${stages}\n      ],`;
    },
    // Stages run in order, so the scenario lasts their sum.
    durationMs: (s) => {
      let sum = 0;
      for (const st of s.stages || []) {
        const d = parseGoDuration(st?.duration);
        if (d === null) return null;
        sum += d;
      }
      return sum;
    },
    validate: (s, where) => {
      const errs = [];
      if (!s.stages || s.stages.length === 0) errs.push(`${where} needs at least one stage`);
      (s.stages || []).forEach((st, i) => {
        if (parseGoDuration(st?.duration) === null) errs.push(`${where} stage ${i + 1}: duration must be a Go duration like '30s' or '1m30s'`);
      });
      return errs;
    },
  },
  'constant-arrival-rate': {
    label: 'Constant Arrival Rate',
    fields: 'rate-duration',
    defaults: { rate: 10, duration: '1m' },
    renderOptions: (s) => `      rate: ${s.rate ?? 10},\n      duration: ${jsString(s.duration || '1m')},`,
    // Holds a flat rate for a single duration; no stages. Falling through to a
    // stages sum would total 0 and pin the progress bar at 100% for the run.
    durationMs: (s) => parseGoDuration(s.duration),
    validate: (s, where) => {
      const errs = [];
      if (parseGoDuration(s.duration) === null) errs.push(`${where}: duration must be a Go duration like '30s' or '1m30s'`);
      if (!(s.rate > 0)) errs.push(`${where}: rate must be > 0`);
      return errs;
    },
  },
};

export const DEFAULT_EXECUTOR = 'ramping-arrival-rate';
export const SUPPORTED_EXECUTORS = Object.keys(EXECUTORS);

/** The executor entry for a scenario; unknown executors resolve to the default
 *  (drafts saved while the picker still offered VU-based executors). */
export const executorOf = (s) => EXECUTORS[s?.executor] || EXECUTORS[DEFAULT_EXECUTOR];

/** How long one scenario runs from t=0 of the test: its startTime offset plus
 *  its executor's own duration. null when any piece is unparsable. */
export function scenarioTotalMs(s) {
  const start = parseGoDuration(s?.startTime || '0s');
  if (start === null) return null;
  const d = executorOf(s).durationMs(s || {});
  return d === null ? null : start + d;
}

/** Runtime of a whole generator: scenarios run concurrently, each offset by its
 *  own startTime, so the node stays busy until the LAST one ends — max, not
 *  sum. null when any scenario is unparsable, so callers refuse rather than guess. */
export function perNodeTotalMs(scenarios) {
  const list = scenarios || [];
  if (list.length === 0) return null;
  let max = 0;
  for (const s of list) {
    const t = scenarioTotalMs(s);
    if (t === null) return null;
    if (t > max) max = t;
  }
  return max;
}

/** Whether a scenario carries an uploaded payload as its request body. */
export const hasImage = (s) => !!(s && s.payloadImageURL);

/** The HTTP method the generated script will actually use. A GET/DELETE cannot
 *  carry a binary body in k6, so an uploaded payload forces POST — exported so
 *  the editor can show the user that coercion instead of applying it silently. */
export function effectiveMethod(s) {
  const m = (s?.method || 'GET').toUpperCase();
  if (hasImage(s) && (m === 'GET' || m === 'DELETE')) return 'POST';
  return m;
}

// ── scenario identity ───────────────────────────────────────────────────────

// Monotonic session counter behind both the stable scenario `id` and the
// default name. Neither may be derived from scenarios.length: remove-then-add
// hands out a name that is still in use, and the generated script keys its
// `scenarios` object BY NAME — a duplicate key silently collapses two scenarios
// into one (last write wins) and that load never runs.
let scenarioSeq = 0;
const nextSeq = () => { scenarioSeq += 1; return scenarioSeq; };
// The timestamp keeps ids unique across a page reload, where the counter
// restarts at 0 while older ids live on in the localStorage draft.
const scenarioId = (seq) => `scn-${seq}-${Date.now().toString(36)}`;

/** A blank scenario with a stable id and a name not present in `existing`. */
export function newScenario(existing = []) {
  const taken = new Set((existing || []).map((s) => s?.name));
  let seq = nextSeq();
  while (taken.has(`scenario_${seq}`)) seq = nextSeq();
  return {
    id: scenarioId(seq),
    name: `scenario_${seq}`,
    executor: DEFAULT_EXECUTOR,
    method: 'GET',
    targetURL: '',
    startTime: '0s',
    preAllocatedVUs: 10,
    maxVUs: 50,
    body: '',
    headers: '{\n  "Content-Type": "application/json"\n}',
    // Every executor's defaults are carried so switching executor in the
    // picker never lands on an undefined field.
    ...Object.values(EXECUTORS).reduce((acc, e) => ({ ...acc, ...e.defaults }), {}),
  };
}

/** Backfills `id` and executor defaults on scenarios restored from an older
 *  draft, and coerces an executor the generator cannot emit to the default so
 *  an old draft stays usable instead of rendering a blank select. */
export function ensureScenarioIds(scenarios) {
  return (scenarios || []).map((s) => {
    const out = s?.id ? { ...s } : { ...s, id: scenarioId(nextSeq()) };
    if (!EXECUTORS[out.executor]) out.executor = DEFAULT_EXECUTOR;
    for (const e of Object.values(EXECUTORS)) {
      for (const [k, v] of Object.entries(e.defaults)) if (out[k] === undefined) out[k] = v;
    }
    return out;
  });
}

// ── validation ──────────────────────────────────────────────────────────────

/** Every rule a scenario list must satisfy before a script is generated.
 *  Returns errors (empty = valid); never throws. `where` prefixes messages. */
export function validateScenarios(scenarios, where = 'Scenario') {
  const errs = [];
  if (!scenarios || scenarios.length === 0) return [`${where}: at least one scenario is required`];
  const seen = new Set();
  for (const s of scenarios) {
    const name = (s.name || '').trim();
    const at = `${where} '${name || '?'}'`;
    if (!name) { errs.push(`${where}: a scenario has an empty name`); continue; }
    // Names key the generated `scenarios` object: a duplicate is legal JS but
    // the later entry overwrites the earlier one, silently dropping a scenario.
    if (seen.has(name)) errs.push(`${where}: two scenarios named '${name}' — names must be unique`);
    seen.add(name);
    if (!s.targetURL) errs.push(`${at}: targetURL is required`);
    if (!s.preAllocatedVUs || s.preAllocatedVUs < 1) errs.push(`${at}: preAllocatedVUs must be >= 1`);
    if (!s.maxVUs || s.maxVUs < 1) errs.push(`${at}: maxVUs must be >= 1`);
    if (parseGoDuration(s.startTime || '0s') === null) errs.push(`${at}: startTime must be a Go duration`);
    if (s.headers) {
      let parsed;
      try { parsed = JSON.parse(s.headers); } catch { parsed = undefined; }
      // Parseable is not enough: `null` and `[]` are valid JSON but not header
      // maps, and the generator splices the text in verbatim.
      if (parsed === undefined || parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        errs.push(`${at}: headers must be a JSON object like {"Content-Type": "application/json"}`);
      }
    }
    errs.push(...executorOf(s).validate(s, at));
  }
  return errs;
}
