import { formatDateTime } from '../lib/format';

// ScheduledStartCard renders the scheduled-start stat card with a live
// countdown. `startAt` is an ISO timestamp; `nowMs` is the parent's ticking
// clock so the countdown updates once per second.
export default function ScheduledStartCard({ startAt, nowMs }) {
  const fireMs = new Date(startAt).getTime();
  const remaining = Math.max(0, fireMs - nowMs);
  let countdown;
  if (remaining === 0) {
    countdown = 'fired';
  } else {
    const totalSec = Math.floor(remaining / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    countdown = `${m}m ${s}s`;
  }
  return (
    <div className="glass-card p-4">
      <p className="text-xs text-surface-450 uppercase tracking-wider">Scheduled start</p>
      <p className="text-sm text-white mt-1">{formatDateTime(startAt)}</p>
      <p className="text-xs font-mono text-dfaas-400 mt-1">{countdown}</p>
    </div>
  );
}
