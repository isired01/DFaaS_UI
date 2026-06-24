import { TR_PHASE_STYLE } from '../lib/constants';

// TestRunBadge renders a small badge for a remote k6 TestRun phase.
// Phase strings (created/started/finished/stopped/error) are protocol values
// reported by the k6-operator.
export default function TestRunBadge({ phase }) {
  const cls = TR_PHASE_STYLE[phase] || TR_PHASE_STYLE.created;
  return <span className={`badge text-[12px] px-2 py-0.5 border ${cls}`}>{phase || '—'}</span>;
}
