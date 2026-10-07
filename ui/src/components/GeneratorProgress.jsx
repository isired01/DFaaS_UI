import { formatGoDuration, parseGoDuration } from '../lib/duration';
import { testRun } from '../lib/crstate';

// GeneratorProgress renders one progress bar per k6 generator.
//
// Why per generator rather than one bar for the test: durations are declared
// per node (spec.perNodeLoad[].duration), the nodes finish independently, and
// the detail page already renders a row per node. A single aggregate bar would
// need an arbitrary rule for what to show when two generators disagree.
//
// What it can and cannot know. The elapsed side is solid: status.startTime is
// stamped when the operator releases the runners. The total is a declaration —
// the form derives it from the scenarios, but a raw pasted script can do
// whatever it likes and nothing validates it. So the bar is an *estimate* and
// is built to say so: once elapsed passes the declared total while the runner
// is still going, it drops to indeterminate rather than sitting frozen at 99%.
// A bar that lies confidently is worse than one that admits it does not know.

const TRACK = 'h-1.5 w-full rounded-full bg-surface-700/60 overflow-hidden';

function Bar({ pct, className }) {
  return (
    <div className={TRACK}>
      <div
        className={`h-full rounded-full transition-[width] duration-1000 ease-linear ${className}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function Indeterminate({ className }) {
  return (
    <div className={TRACK}>
      <div className={`h-full w-full rounded-full animate-pulse ${className}`} />
    </div>
  );
}

// state derives what to draw from the two things actually observed: the remote
// stage and the elapsed time. Pure, so the render below stays a lookup.
function state({ stage, phase, startTime, durationMs, nowMs }) {
  if (stage === 'error') {
    return { kind: 'error', label: 'runner error' };
  }
  if (testRun.done(stage)) {
    return { kind: 'done', label: stage === 'stopped' ? 'stopped' : 'finished' };
  }
  // Aborted/Failed can leave a runner mid-flight; the test is over either way.
  if (phase === 'Aborted' || phase === 'Failed') {
    return { kind: 'idle', label: phase === 'Aborted' ? 'aborted' : 'test failed' };
  }
  if (phase === 'Exporting' || phase === 'Completed') {
    return { kind: 'done', label: 'load finished' };
  }
  // Dispatched but not yet running: queued, or parked on the sync barrier.
  if (stage !== 'started') {
    return { kind: 'waiting', label: stage ? `${stage}…` : 'waiting to start' };
  }

  const startMs = startTime ? Date.parse(startTime) : NaN;
  if (!Number.isFinite(startMs) || !Number.isFinite(durationMs) || durationMs <= 0) {
    return { kind: 'running-unknown', label: 'running' };
  }

  const elapsed = nowMs - startMs;
  if (elapsed < 0) {
    // Browser clock behind the cluster's. Don't render a negative bar.
    return { kind: 'running-unknown', label: 'running' };
  }
  // Elapsed is rounded down to whole seconds: the ticker runs at 1 Hz, so
  // millisecond precision would only add noise like "11s503ms".
  const elapsedLabel = formatGoDuration(Math.floor(elapsed / 1000) * 1000);
  if (elapsed > durationMs) {
    return {
      kind: 'overrun',
      label: `running ${elapsedLabel} — past the declared ${formatGoDuration(durationMs)}`,
    };
  }
  return {
    kind: 'running',
    pct: Math.min(100, (elapsed / durationMs) * 100),
    label: `${elapsedLabel} / ${formatGoDuration(durationMs)}`,
  };
}

export default function GeneratorProgress({ stage, phase, startTime, duration, nowMs }) {
  const durationMs = parseGoDuration(duration);
  const s = state({ stage, phase, startTime, durationMs, nowMs });

  // Percentage is announced only when it is real. A settled bar (finished /
  // error) is 100% and says so; a genuinely unknown one omits aria-valuenow so
  // a screen reader reports "busy" rather than inventing a number.
  const DETERMINATE = { running: () => Math.round(s.pct), done: () => 100, error: () => 100, idle: () => 0 };
  const aria = DETERMINATE[s.kind]
    ? { 'aria-valuenow': DETERMINATE[s.kind](), 'aria-valuemin': 0, 'aria-valuemax': 100 }
    : {};

  let bar;
  switch (s.kind) {
    case 'running':
      bar = <Bar pct={s.pct} className="bg-amber-400" />;
      break;
    case 'done':
      bar = <Bar pct={100} className="bg-emerald-400" />;
      break;
    case 'error':
      bar = <Bar pct={100} className="bg-red-400" />;
      break;
    case 'overrun':
    case 'running-unknown':
      bar = <Indeterminate className="bg-amber-400/60" />;
      break;
    case 'waiting':
      bar = <Indeterminate className="bg-surface-450/60" />;
      break;
    default:
      bar = <Bar pct={0} className="bg-surface-450" />;
  }

  return (
    <div className="mt-2" role="progressbar" aria-label={`Progress for generator, ${s.label}`} {...aria}>
      {bar}
      <p className="mt-1 text-[12px] text-surface-450 font-mono">{s.label}</p>
    </div>
  );
}
