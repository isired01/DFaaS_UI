import { Plus, Trash2, Network } from 'lucide-react';

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

      {links.length === 0 ? (
        <p className="text-xs text-surface-500">No topology links. Add latency edges between nodes if needed.</p>
      ) : links.map((link, i) => (
        <div key={i} className="grid grid-cols-12 gap-2 items-end">
          <div className="col-span-4">
            <label className="block text-[10px] text-surface-500 mb-1">Node A</label>
            <select className="input py-1.5 text-xs" value={link.nodeA} onChange={(e) => onUpdate(i, { nodeA: e.target.value })} required>
              <option value="">—</option>
              {nodeIDs.map(id => <option key={id} value={id}>{id}</option>)}
            </select>
          </div>
          <div className="col-span-4">
            <label className="block text-[10px] text-surface-500 mb-1">Node B</label>
            <select className="input py-1.5 text-xs" value={link.nodeB} onChange={(e) => onUpdate(i, { nodeB: e.target.value })} required>
              <option value="">—</option>
              {nodeIDs.map(id => <option key={id} value={id}>{id}</option>)}
            </select>
          </div>
          <div className="col-span-3">
            <label className="block text-[10px] text-surface-500 mb-1">Latency (ms)</label>
            <input type="number" min="0" className="input py-1.5 text-xs" value={link.latencyMs} onChange={(e) => onUpdate(i, { latencyMs: e.target.value })} required />
          </div>
          <div className="col-span-1">
            <button type="button" onClick={() => onRemove(i)} className="p-1.5 text-surface-500 hover:text-red-400">
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
