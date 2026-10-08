import { Plus, Trash2, Network, AlertTriangle } from 'lucide-react';

// LinkEditor renders the topology-links section of the EnvironmentNew form:
// per-link Node A / Node B selectors (from the current node IDs) and a latency
// input. State lives in the parent (EnvironmentNew).
export default function LinkEditor({ links, nodeIDs, onAdd, onRemove, onUpdate }) {
  return (
    <div className="glass-card p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-surface-300 uppercase tracking-wider flex items-center gap-2">
          <Network className="w-4 h-4" />Topology Links ({links.length})
        </h2>
      </div>

      <div className="flex items-start gap-2 p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-300 text-[13px] leading-snug">
        <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
        <span>
          <strong>Not supported yet — placeholder.</strong> Links are saved on the Environment but the operator does not currently apply any latency between nodes, so this value has no effect for now. Once implemented, the latency is meant to be <strong>bidirectional</strong> — applied symmetrically to both directions of the A↔B link.
        </span>
      </div>

      {links.length === 0 ? (
        <p className="text-xs text-surface-450">No topology links. Add latency edges between nodes if needed.</p>
      ) : links.map((link, i) => (
        <div key={i} className="grid grid-cols-12 gap-2 items-end">
          <div className="col-span-4">
            <label htmlFor={`link-${i}-nodeA`} className="block text-[12px] text-surface-450 mb-1">Node A</label>
            <select id={`link-${i}-nodeA`} className="input py-1.5 text-xs" value={link.nodeA} onChange={(e) => onUpdate(i, { nodeA: e.target.value })} required>
              <option value="">—</option>
              {nodeIDs.map(id => <option key={id} value={id}>{id}</option>)}
            </select>
          </div>
          <div className="col-span-4">
            <label htmlFor={`link-${i}-nodeB`} className="block text-[12px] text-surface-450 mb-1">Node B</label>
            <select id={`link-${i}-nodeB`} className="input py-1.5 text-xs" value={link.nodeB} onChange={(e) => onUpdate(i, { nodeB: e.target.value })} required>
              <option value="">—</option>
              {nodeIDs.map(id => <option key={id} value={id}>{id}</option>)}
            </select>
          </div>
          <div className="col-span-3">
            <label htmlFor={`link-${i}-latencyMs`} className="block text-[12px] text-surface-450 mb-1">Latency (ms)</label>
            <input id={`link-${i}-latencyMs`} type="number" min="0" className="input py-1.5 text-xs" value={link.latencyMs} onChange={(e) => onUpdate(i, { latencyMs: e.target.value })} required />
          </div>
          <div className="col-span-1">
            <button type="button" onClick={() => onRemove(i)} aria-label={`Remove link ${i + 1}`} title="Remove link" className="p-1.5 text-surface-450 hover:text-red-400">
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      ))}
      <div className="flex justify-end">
        <button type="button" onClick={onAdd} className="btn-secondary text-xs px-3 py-1.5">
          <Plus className="w-3.5 h-3.5" />Add Link
        </button>
      </div>
    </div>
  );
}
