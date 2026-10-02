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

  // No path, no relocation: old drafts and external-S3 assets must get exactly
  // the block they always got, so it is pinned byte for byte.
  assert.doesNotMatch(script, /DFAAS_ASSET_BASE/, 'a scenario without payloadImagePath must not read DFAAS_ASSET_BASE');
  const url = JSON.stringify(img.payloadImageURL);
  const name = JSON.stringify(img.name);
  const pinned = `  {
    const __r = http.get(${url}, { responseType: 'binary' });
    if (__r.status === 200 && __r.body && __r.body.byteLength > 0) {
      payloads[${name}] = encoding.b64encode(__r.body);
    } else {
      exec.test.abort('setup: payload image for scenario ' + ${name} + ' could not be fetched from ' + ${url} + ' (status=' + __r.status + (__r.error ? ', ' + __r.error : '') + ')' + (__r.status === 0 ? '; SEAWEEDFS_PUBLIC_URL must be reachable from every k6 generator' : ''));
    }
  }`;
  assert.ok(script.includes(pinned), 'a path-less image scenario must emit the pre-relocation fetch block unchanged');

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

// --- a relocatable image scenario: DFAAS_ASSET_BASE + path, baked URL last --
// An upload to the in-cluster SeaweedFS carries payloadImagePath. The script
// must prefer the base the operator built for THIS generator and fall back to
// the baked URL, and its abort must name the URL it actually fetched.
const REL = {
  payloadImageURL: 'http://10.0.0.1:30900/b/assets/a.png',
  payloadImagePath: '/b/assets/a.png',
  payloadContentType: 'image/png',
};
{
  const rel = scenario(REL);
  const script = generateK6Script([rel]);

  assert.match(script, /const __raw = __ENV\.DFAAS_ASSET_BASE \|\| '';/, 'the base is read once, unset and empty alike');
  assert.match(script, /__raw\.endsWith\('\/'\) \? __raw\.slice\(0, -1\) : __raw/, 'one trailing slash is trimmed without a regex');
  const sel = script.match(/const __u = (.*);/);
  assert.ok(sel, 'the fetched URL is chosen at runtime');
  assert.equal(sel[1], `__base ? __base + ${JSON.stringify(rel.payloadImagePath)} : ${JSON.stringify(rel.payloadImageURL)}`,
    'DFAAS_ASSET_BASE + path wins when the base is non-empty, the baked URL otherwise');
  assert.match(script, /http\.get\(__u, \{ responseType: 'binary' \}\);/, 'the fetch uses the chosen URL');

  const abortArg = script.match(/exec\.test\.abort\(([\s\S]*?)\);/)[1];
  assert.ok(abortArg.includes(JSON.stringify(rel.name)), 'abort message must name the scenario');
  assert.ok(abortArg.includes("' could not be fetched from ' + __u + '"), 'abort message must name the URL actually fetched');
  assert.ok(!abortArg.includes(JSON.stringify(rel.payloadImageURL)), 'the baked literal may not be what was fetched');
  assert.ok(abortArg.includes('__r.status'), 'abort message must report the transport status');
  assert.match(abortArg, /__r\.status\s*===\s*0 \? \(__base \?/, 'the hint stays behind the status-0 check and is picked by source');
  assert.ok(abortArg.includes('DFAAS_ASSET_BASE') && abortArg.includes('SEAWEEDFS_PUBLIC_URL'), 'both hints are emitted, one per source');

  // Still before the barrier, still one binary fetch.
  assert.equal([...script.matchAll(/responseType: 'binary'/g)].length, 1);
  assert.ok(script.indexOf('__ENV.DFAAS_ASSET_BASE') < script.indexOf('__ENV.DFAAS_SYNC_URL'), 'the relocated fetch runs before the barrier');
  assert.equal(parses(script), null, 'a relocatable scenario must parse');
}

// Quotes in the path and in the scenario name stay escaped.
{
  const p = `/b/assets/x'y"z.png`;
  const n = `it's "quoted"`;
  const script = generateK6Script([scenario({ ...REL, name: n, payloadImagePath: p })]);
  assert.ok(script.includes(`__base + ${JSON.stringify(p)} :`), 'the path must be emitted through jsString');
  assert.ok(script.includes(JSON.stringify(n)), 'the name must be emitted through jsString');
  assert.equal(parses(script), null, 'quotes in a path or name must not break the script');
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
    // These two catch a regex written inside the generator's templates (a
    // lost backslash turns into a line comment) and an apostrophe in a
    // hand-written hint literal.
    ['relocatable image', [scenario(REL)]],
    ['mixed relocatable + baked + text', [
      scenario(REL),
      scenario({ payloadImageURL: 'https://s3.example.org/b/assets/b.png', payloadContentType: 'image/png' }),
      scenario({ method: 'PUT', body: '{"a":1}' }),
    ]],
  ];

  for (const [label, scenarios] of cases) {
    const err = parses(generateK6Script(scenarios));
    assert.equal(err, null, `generated script does not parse (${label}): ${err}`);
  }
}

// --- setup() behaviour: what is fetched, and what the abort says ----------
// node --check only proves the script parses. This runs the generated setup()
// for real: imports dropped, `export ` removed, and http, exec, encoding and
// __ENV stubbed. exec.test.abort ends the k6 test, so the stub throws a
// sentinel and nothing after it runs.
const ABORTED = new Error('k6 test aborted');
function runSetup(script, env, respond) {
  const body = script
    .split('\n')
    .filter((l) => !l.startsWith('import '))
    .join('\n')
    .replace(/^export /gm, '');
  const fetched = [];
  const aborts = [];
  const http = { get: (u) => { fetched.push(u); return respond(u); } };
  const exec = { test: { abort: (msg) => { aborts.push(msg); throw ABORTED; } } };
  const encoding = { b64encode: () => 'b64', b64decode: () => null };
  const mod = new Function('http', 'check', 'sleep', 'encoding', 'exec', '__ENV', `${body}\nreturn { setup };`)(
    http, () => true, () => {}, encoding, exec, env,
  );
  let data;
  try { data = mod.setup(); } catch (e) { if (e !== ABORTED) throw e; }
  return { fetched, aborts, data };
}
const down = () => ({ status: 0, error: 'dial tcp: i/o timeout', body: null });
const okBody = () => ({ status: 200, body: { byteLength: 3 } });
{
  const rel = scenario(REL);
  const baked = scenario({ payloadImageURL: 'https://s3.example.org/b/assets/b.png', payloadContentType: 'image/png' });
  const script = generateK6Script([rel, baked]);
  const relocated = 'http://100.64.0.7:30900/b/assets/a.png';

  // A detected base, with and without a trailing slash: base + path.
  for (const base of ['http://100.64.0.7:30900', 'http://100.64.0.7:30900/']) {
    const { fetched, aborts } = runSetup(script, { DFAAS_ASSET_BASE: base }, down);
    assert.deepEqual(fetched, [relocated], `base ${base}: fetch base + path, once, and stop at the abort`);
    assert.equal(aborts.length, 1);
    assert.ok(aborts[0].includes(`could not be fetched from ${relocated} (status=0, dial tcp: i/o timeout)`), `base ${base}: the abort names the URL fetched: ${aborts[0]}`);
    assert.ok(aborts[0].includes(`scenario ${rel.name} could not be fetched`), 'the abort names the scenario');
    assert.ok(aborts[0].includes('; DFAAS_ASSET_BASE'), 'a relocated fetch gets the DFAAS_ASSET_BASE hint');
    assert.ok(!aborts[0].includes('SEAWEEDFS_PUBLIC_URL'), 'SEAWEEDFS_PUBLIC_URL played no part in a relocated fetch');
  }

  // Unset and empty alike: the baked URL, with the SEAWEEDFS_PUBLIC_URL hint.
  for (const env of [{}, { DFAAS_ASSET_BASE: '' }]) {
    const { fetched, aborts } = runSetup(script, env, down);
    assert.deepEqual(fetched, [REL.payloadImageURL], `${JSON.stringify(env)}: fall back to the baked URL`);
    assert.ok(aborts[0].includes(`could not be fetched from ${REL.payloadImageURL} (status=0`), aborts[0]);
    assert.ok(aborts[0].includes('; SEAWEEDFS_PUBLIC_URL must be reachable from every k6 generator'));
    assert.ok(!aborts[0].includes('DFAAS_ASSET_BASE'), 'no base was used, so it must not be blamed');
  }

  // A real HTTP answer gets no reachability hint from either source.
  {
    const { aborts } = runSetup(script, { DFAAS_ASSET_BASE: 'http://100.64.0.7:30900' }, () => ({ status: 403, body: null }));
    assert.ok(aborts[0].endsWith('(status=403)'), `no hint on a 403: ${aborts[0]}`);
  }

  // Success: the path-less scenario ignores the base, both payloads land, and
  // the barrier runs after the fetches.
  {
    const sync = 'http://100.64.0.1:30901/dfaas-sync/go';
    const { fetched, aborts, data } = runSetup(script, { DFAAS_ASSET_BASE: 'http://100.64.0.7:30900', DFAAS_SYNC_URL: sync }, okBody);
    assert.equal(aborts.length, 0);
    assert.deepEqual(fetched, [relocated, baked.payloadImageURL, sync], 'fetches first, then the barrier; a path-less scenario keeps its baked URL');
    assert.deepEqual(data, { payloads: { [rel.name]: 'b64', [baked.name]: 'b64' } });
  }

  // An IPv6 base arrives bracketed from the operator and is used as-is.
  {
    const { fetched } = runSetup(script, { DFAAS_ASSET_BASE: 'http://[fd7a:115c:a1e0::7]:30900' }, down);
    assert.deepEqual(fetched, ['http://[fd7a:115c:a1e0::7]:30900/b/assets/a.png']);
  }
}
// Quotes in the path survive to the URL actually requested.
{
  const p = `/b/assets/x'y"z.png`;
  const script = generateK6Script([scenario({ ...REL, name: `it's "quoted"`, payloadImagePath: p })]);
  const { fetched, aborts } = runSetup(script, { DFAAS_ASSET_BASE: 'http://100.64.0.7:30900' }, down);
  assert.deepEqual(fetched, [`http://100.64.0.7:30900${p}`]);
  assert.ok(aborts[0].includes(`scenario it's "quoted" could not be fetched from http://100.64.0.7:30900${p}`), aborts[0]);
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
