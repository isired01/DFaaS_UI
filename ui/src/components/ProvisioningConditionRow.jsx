import { CheckCircle2, Loader2, XCircle } from 'lucide-react';

// Condition reasons that mean the stream is dead, not still working. Without
// JobCreationFailed the row keeps spinning the amber in-progress icon forever.
// CheckFailed means readiness could not be evaluated at all (e.g. an RBAC
// regression) — the operator raises it precisely so it stops looking like
// "still starting", so it must not render as an in-progress spinner.
const FAILED_REASONS = new Set(['AnsibleFailed', 'HelmFailed', 'JobCreationFailed', 'CheckFailed']);

// ProvisioningConditionRow renders a single provisioning-progress row on the
// Environment detail page: it picks the matching status condition by `type` and
// shows a spinner / check / error icon based on its status and reason.
export default function ProvisioningConditionRow({ conditions, type, label }) {
  const c = (conditions || []).find(x => x.type === type);
  const status = c?.status || 'Unknown';
  const reason = c?.reason || '';
  const message = c?.message || '';

  let Icon = Loader2;
  let iconClass = 'text-amber-400 animate-spin';
  let bgClass = 'bg-amber-500/10 border-amber-500/30';
  if (status === 'True') {
    Icon = CheckCircle2;
    iconClass = 'text-emerald-400';
    bgClass = 'bg-emerald-500/10 border-emerald-500/30';
  } else if (FAILED_REASONS.has(reason)) {
    Icon = XCircle;
    iconClass = 'text-red-400';
    bgClass = 'bg-red-500/10 border-red-500/30';
  }

  return (
    <div className={`p-3 rounded-xl border flex items-start gap-3 ${bgClass}`} id={`condition-${type}`}>
      <Icon className={`w-5 h-5 flex-shrink-0 mt-0.5 ${iconClass}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-white">{label}</span>
          {reason && <span className="text-[12px] text-surface-400 uppercase tracking-wider">{reason}</span>}
        </div>
        {message && <p className="text-xs text-surface-300 mt-1 truncate">{message}</p>}
      </div>
    </div>
  );
}
