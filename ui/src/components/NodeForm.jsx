import { Trash2, Lock } from 'lucide-react';
import { BALANCING_STRATEGIES } from '../lib/constants';
import FormField from './FormField';

const CAPACITIES = ['LOW', 'MEDIUM', 'HIGH'];

// Role `value`s are kebab-case protocol enums consumed by the operator CRD.
const ROLES = [
  { value: '',                  label: '— select role —' },
  { value: 'dfaas-worker',      label: 'dFaaS Worker' },
  { value: 'k6-load-generator', label: 'k6 Load Generator' },
];

const FN_LABEL = 'block text-[10px] text-surface-500 mb-1';

// NodeForm renders a single editable node card: identity, role/capacity/creds,
// and (for dfaas-worker) the balancing strategy and OpenFaaS functions table.
// All state lives in the parent (EnvironmentNew).
export default function NodeForm({
  node,
  index,
  canRemove,
  onUpdate,
  onRemove,
  onAddFunction,
  onRemoveFunction,
  onUpdateFunction,
}) {
  const isRecalc = node.balancingStrategy === 'recalcstrategy';

  const handleRoleChange = (role) => {
    if (role === 'k6-load-generator') {
      onUpdate({ role, balancingStrategy: '', functions: [] });
    } else if (role === 'dfaas-worker') {
      onUpdate({ role, balancingStrategy: node.balancingStrategy || 'recalcstrategy' });
    } else {
      onUpdate({ role: '', balancingStrategy: '', functions: [] });
    }
  };

  return (
    <div className="border border-surface-700/50 rounded-xl p-4 space-y-3 bg-surface-900/30">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-white">Node #{index + 1}{node.nodeID && ` — ${node.nodeID}`}</span>
        <button type="button" onClick={onRemove} disabled={!canRemove} className="p-1.5 text-surface-500 hover:text-red-400 disabled:opacity-30">
          <Trash2 className="w-4 h-4" />
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <FormField
          label="Node ID"
          labelClassName="block text-xs font-medium text-surface-400 mb-1 flex items-center gap-1"
          labelExtra={node._locked && <Lock className="w-3 h-3 text-surface-500" title="nodeID is immutable on existing nodes (keys the libp2p Secret)" />}
        >
          <input
            type="text"
            className={`input py-2 text-sm ${node._locked ? 'opacity-60 cursor-not-allowed' : ''}`}
            value={node.nodeID}
            onChange={(e) => onUpdate({ nodeID: e.target.value })}
            readOnly={!!node._locked}
            required
            title={node._locked ? 'nodeID cannot be changed on an existing node (keys libp2p Secret)' : ''}
          />
        </FormField>
        <FormField label="IP Address">
          <input type="text" className="input py-2 text-sm" value={node.ipAddress} onChange={(e) => onUpdate({ ipAddress: e.target.value })} placeholder="10.0.0.1" required />
        </FormField>
        <FormField label="Role">
          <select className="input py-2 text-sm" value={node.role} onChange={(e) => handleRoleChange(e.target.value)}>
            {ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </FormField>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <FormField label="Capacity">
          <select className="input py-2 text-sm" value={node.capacity} onChange={(e) => onUpdate({ capacity: e.target.value })}>
            {CAPACITIES.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </FormField>
        <FormField label="Username">
          <input type="text" className="input py-2 text-sm" value={node.username} onChange={(e) => onUpdate({ username: e.target.value })} required />
        </FormField>
        <FormField label="Password">
          <input type="text" className="input py-2 text-sm" value={node.password} onChange={(e) => onUpdate({ password: e.target.value })} required />
        </FormField>
      </div>

      {node.role === 'dfaas-worker' && (
        <>
          <FormField label="Balancing Strategy">
            <select className="input py-2 text-sm" value={node.balancingStrategy} onChange={(e) => onUpdate({ balancingStrategy: e.target.value })}>
              {BALANCING_STRATEGIES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </FormField>

          <div className="border-t border-surface-700/50 pt-3">
            <div className="flex items-center justify-between mb-2">
              <label className="block text-xs font-medium text-surface-400">Functions ({node.functions.length})</label>
            </div>
            <div className="space-y-2">
              {node.functions.map((fn, fIdx) => (
                <div key={fIdx} className="grid grid-cols-12 gap-2 items-end">
                  <div className="col-span-3">
                    <label className={FN_LABEL}>Name</label>
                    <input type="text" className="input py-1.5 text-xs" value={fn.name} onChange={(e) => onUpdateFunction(fIdx, { name: e.target.value })} required />
                  </div>
                  <div className="col-span-3">
                    <label className={FN_LABEL}>Image</label>
                    <input type="text" className="input py-1.5 text-xs" value={fn.image} onChange={(e) => onUpdateFunction(fIdx, { image: e.target.value })} required />
                  </div>
                  <div className="col-span-1">
                    <label className={FN_LABEL}>Exec(s)</label>
                    <input type="number" className="input py-1.5 text-xs" value={fn.execTimeout} onChange={(e) => onUpdateFunction(fIdx, { execTimeout: e.target.value })} />
                  </div>
                  <div className="col-span-1">
                    <label className={FN_LABEL}>Max</label>
                    <input type="number" className="input py-1.5 text-xs" value={fn.maxInflight} onChange={(e) => onUpdateFunction(fIdx, { maxInflight: e.target.value })} />
                  </div>
                  <div className={isRecalc ? 'col-span-2' : 'col-span-3'}>
                    <label className={FN_LABEL}>Timeout(ms)</label>
                    <input type="number" className="input py-1.5 text-xs" value={fn.timeoutMs} onChange={(e) => onUpdateFunction(fIdx, { timeoutMs: e.target.value })} />
                  </div>
                  {isRecalc && (
                    <div className="col-span-1">
                      <label className={FN_LABEL} title="Rate limit consumed by recalcstrategy">Rate(r/s)</label>
                      <input type="number" min="1" className="input py-1.5 text-xs" value={fn.maxRate} onChange={(e) => onUpdateFunction(fIdx, { maxRate: e.target.value })} />
                    </div>
                  )}
                  <div className="col-span-1">
                    <button type="button" onClick={() => onRemoveFunction(fIdx)} className="p-1.5 text-surface-500 hover:text-red-400">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-2 flex justify-end">
              <button type="button" onClick={onAddFunction} className="text-[10px] text-dfaas-400 hover:text-dfaas-300 font-medium">
                + Add Function
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
