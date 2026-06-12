// ConditionsList renders the "Conditions" panel shared by the LoadTest and
// Environment detail pages: a titled card with one row per status condition.
export default function ConditionsList({ conditions }) {
  if (!conditions || conditions.length === 0) return null;
  return (
    <div className="glass-card p-5">
      <h2 className="text-sm font-semibold text-surface-300 uppercase tracking-wider mb-3">Conditions</h2>
      <div className="space-y-2">
        {conditions.map((c, i) => (
          <div key={i} className="flex items-start justify-between gap-4 p-3 rounded-xl bg-surface-900/50 border border-surface-700/30">
            <div className="flex items-center gap-3 min-w-0 shrink-0">
              <div className={`w-2 h-2 rounded-full ${c.status === 'True' ? 'bg-emerald-400' : 'bg-amber-400'}`} />
              <span className="text-sm font-medium text-white">{c.type}</span>
              <span className="text-xs text-surface-500">{c.reason}</span>
            </div>
            <span className="text-xs text-surface-400 text-right break-words">{c.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
