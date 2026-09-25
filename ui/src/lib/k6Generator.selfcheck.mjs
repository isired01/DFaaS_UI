// Self-check for lib/k6Generator.js. No test framework in this repo, so this is
// a plain assert script: `node src/lib/k6Generator.selfcheck.mjs`.
//
// generateK6Script is already a pure function -- the seam is perfect -- and it
// had no selfcheck at all. The only assertion touching it anywhere was one line
// in payloads/loadtest.selfcheck.mjs matching /executor: 'ramping-arrival-rate'/,
// which exercises renderScenario and nothing else.
//
// That left unexercised exactly the code whose failures are, by its own
// comments, invisible: "k6 rejects an option set that does not match its
// executor, and that rejection lands on the remote runner after dispatch, where
// nobody sees it." The parse assertion at the bottom is the point of this file:
// it turns "malformed script discovered on a remote runner, mid-experiment"
// into "malformed script discovered in npm run check".

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateK6Script } from './k6Generator.js';
import { newScenario } from './scenarios.js';

// scenario builds a valid scenario with overrides. Going through newScenario
// keeps the fixtures honest: if the shape the editor produces changes, these
// change with it.
let seq = [];
function scenario(overrides = {}) {
  const s = newScenario(seq);
  seq = [...seq, s];
  return { ...s, targetURL: 'http://10.0.0.1:30080/function/figlet', ...overrides };
}

// parses reports whether the emitted script is syntactically valid ESM, via
// `node --check` on a temp .mjs file. That only parses -- nothing runs, so the
// k6 imports are never resolved -- and it needs no runtime flag, which matters
// because the check chain invokes plain `node`.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'k6gen-'));
process.on('exit', () => fs.rmSync(tmpDir, { recursive: true, force: true }));
let tmpSeq = 0;
function parses(script) {
  const file = path.join(tmpDir, `script-${tmpSeq++}.mjs`);
  fs.writeFileSync(file, script);
  const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  return res.status === 0 ? null : (res.stderr || 'node --check failed').trim();
}

// The parse check must actually reject something, or every assertion built on
// it is false confidence.
assert.notEqual(parses("export const x = {"), null, 'node --check must reject malformed input');
assert.equal(parses("export const x = 1;\n"), null, 'node --check must accept valid ESM');

// --- setup() is always emitted ---------------------------------------------
// It carries the sync barrier, so it must exist even with no image payloads --
// and it must still return { payloads } so the per-VU decoders keep reading
// data.payloads unchanged.
{
  const script = generateK6Script([scenario()]);
  assert.match(script, /export function setup\(\)/, 'setup() must be emitted with zero images');
  assert.match(script, /return \{ payloads \};/, 'setup() must return { payloads }');
  assert.match(script, /const payloads = \{\};/);
  // k6's default setupTimeout is 60s, which would kill the barrier wait.
  assert.match(script, /setupTimeout: '10m'/, 'the barrier needs a raised setupTimeout');
  // No images: no encoding import, no decoder.
  assert.doesNotMatch(script, /k6\/encoding/, 'the encoding import is only needed for images');
  assert.doesNotMatch(script, /__getImg_/, 'no decoder without an image');
  assert.doesNotMatch(script, /k6\/execution/, 'the execution import is only needed for images');
}

// --- the sync barrier: exactly once, and LAST ------------------------------
{
  const withImages = generateK6Script([
    scenario({ payloadImageURL: 'http://10.0.0.1:30900/b/assets/a.png', payloadContentType: 'image/png' }),
    scenario({ payloadImageURL: 'http://10.0.0.1:30900/b/assets/b.jpg', payloadContentType: 'image/jpeg' }),
  ]);

  const loops = withImages.match(/while \(http\.get\(__ENV\.DFAAS_SYNC_URL\)\.status !== 200\)/g) || [];
  assert.equal(loops.length, 1, 'the barrier loop must appear exactly once');

  // The ordering invariant, comment-only until now: "The sync barrier is
  // emitted LAST, after any image fetches, so that payload warmup happens
  // while we wait."
  const barrierAt = withImages.indexOf('__ENV.DFAAS_SYNC_URL');
  const fetchPositions = [...withImages.matchAll(/responseType: 'binary'/g)].map(m => m.index);
  assert.equal(fetchPositions.length, 2, 'one binary fetch per image scenario');
  for (const at of fetchPositions) {
    assert.ok(at < barrierAt,
      'every payload fetch must be emitted BEFORE the barrier, so warmup overlaps the wait');
  }
}

// --- an image scenario: bodyLoader, a matching decoder, and no body -------
{
  const img = scenario({ payloadImageURL: 'http://10.0.0.1:30900/b/assets/a.png', payloadContentType: 'image/png' });
  const script = generateK6Script([img]);

  assert.match(script, /bodyLoader: __getImg_0,/, 'the config must expose the loader');
  assert.match(script, /function __getImg_0\(data\) \{/, 'the loader it names must exist');
  assert.match(script, /contentType: "image\/png"/, "the file's own MIME type is attached");
  assert.match(script, /k6\/encoding/, 'the decoder needs the encoding module');
  assert.match(script, /import exec from 'k6\/execution';/, 'the payload abort needs k6/execution');
  assert.doesNotMatch(script, /console\.log\('setup: payload fetch failed/, 'no silent fallback: the test must not run without its image');

  // The abort call is the spec, not just its presence: it must name THIS
  // fixture's own scenario and URL and report the transport status, so a
  // human reading a k6 runner log can act on it without re-deriving anything.
  const abortMatch = script.match(/exec\.test\.abort\(([\s\S]*?)\);/);
  assert.ok(abortMatch, 'a failed payload fetch aborts the test');
  const abortArg = abortMatch[1];
  assert.ok(abortArg.includes(JSON.stringify(img.name)), 'abort message must name the scenario');
  assert.ok(abortArg.includes(JSON.stringify(img.payloadImageURL)), "abort message must carry the fixture's payload URL literal");
  assert.ok(abortArg.includes('__r.status'), 'abort message must report the transport status');
  // F1: SEAWEEDFS_PUBLIC_URL reachability is only the right diagnosis for a
  // transport failure (status 0, no HTTP answer at all) -- a 403 (bucket
  // policy not applied), a 404 (object gone) or an external S3 config are
  // real HTTP responses that hint would misdiagnose. So it must be gated by a
  // status-0 check, not appended unconditionally.
  assert.ok(abortArg.includes('SEAWEEDFS_PUBLIC_URL'), 'abort message must still carry the reachability hint for a transport failure');
  assert.match(abortArg, /__r\.status\s*===\s*0/, 'the SEAWEEDFS_PUBLIC_URL hint must be guarded by a status-0 (no HTTP answer) check');

  // A `body:` key alongside bodyLoader would be dead weight at best and, if
  // runScenario ever read it first, a non-image POST at worst.
  assert.doesNotMatch(script, /^\s*body: /m, 'an image scenario must not also emit a body');
  // The decode is cached per VU, not per iteration.
  assert.match(script, /let __img_0 = undefined;/);
  // Defensive only: setup() now aborts the test itself on a real fetch
  // failure (asserted above). This null-payload branch is reachable only when
  // setup() did not run at all, e.g. `k6 run --no-setup`.
  assert.match(script, /check\(null, \{ 'payload image available': \(\) => false \}\);/);
}

// The decoder index must track the scenario's position, not the image count:
// a text scenario followed by an image one must produce __getImg_1.
{
  const script = generateK6Script([
    scenario(),
    scenario({ payloadImageURL: 'http://10.0.0.1:30900/b/assets/a.png', payloadContentType: 'image/png' }),
  ]);
  assert.match(script, /bodyLoader: __getImg_1,/, 'the loader is keyed by scenario index');
  assert.match(script, /function __getImg_1\(data\) \{/);
  assert.doesNotMatch(script, /__getImg_0/, 'there is no image at index 0');
}

// --- a GET carrying an image is coerced to POST ---------------------------
// http.get sends no body, so a GET with a payload would silently send nothing
// and the function would answer "unknown format".
{
  const script = generateK6Script([
    scenario({
      method: 'GET',
      payloadImageURL: 'http://10.0.0.1:30900/b/assets/a.png',
      payloadContentType: 'image/png',
    }),
  ]);
  assert.match(script, /method: 'POST',/, 'a GET with an image payload must become a POST');
  assert.doesNotMatch(script, /method: 'GET',/);
}

// --- every user string survives as a JS literal ---------------------------
// targetURL, startTime, stage durations and the scenario name used to be
// interpolated raw into single-quoted literals, so an ordinary URL produced an
// unterminated string that only failed at remote k6 parse time.
{
  const nasty = "http://10.0.0.1:30080/function/figlet?q=O'Brien&x=\"y\"";
  const script = generateK6Script([scenario({ targetURL: nasty })]);
  assert.ok(script.includes(JSON.stringify(nasty)),
    'the URL must be emitted through jsString, escapes intact');
  // And the apostrophe must not appear inside a single-quoted literal.
  assert.doesNotMatch(script, /url: '[^']*O'Brien/);
  assert.equal(parses(script), null, 'an apostrophe in the URL must not break the script');
}

// --- the whole script parses ----------------------------------------------
// The assertion that converts a post-dispatch failure into a check-time one.
{
  const cases = [
    ['a single text scenario', [scenario()]],
    ['two scenarios', [scenario(), scenario()]],
    ['an image scenario', [scenario({
      payloadImageURL: 'http://10.0.0.1:30900/b/assets/a.png',
      payloadContentType: 'image/png',
    })]],
    ['a mix of text and image', [
      scenario(),
      scenario({ payloadImageURL: 'http://10.0.0.1:30900/b/assets/a.png', payloadContentType: 'image/png' }),
      scenario({ method: 'PUT', body: '{"a":1}' }),
    ]],
    ['a body with a newline and quotes', [scenario({ body: 'line1\n"quoted"\n' })]],
  ];

  for (const [label, scenarios] of cases) {
    const err = parses(generateK6Script(scenarios));
    assert.equal(err, null, `generated script does not parse (${label}): ${err}`);
  }
}

// --- degenerate input -----------------------------------------------------
assert.equal(generateK6Script([]), '', 'no scenarios means no script');
assert.equal(generateK6Script(null), '');

// A duplicate scenario name silently drops a whole scenario (the generator
// keys JS object literals by name and duplicate keys are legal JS, last wins),
// so generation must refuse rather than emit it.
assert.throws(
  () => generateK6Script([scenario({ name: 'same' }), scenario({ name: 'same' })]),
  /.*/,
  'duplicate scenario names must be refused, not silently collapsed',
);

console.log('k6Generator.js self-check: all assertions passed');
