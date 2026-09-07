import { Trash2, Lock, AlertTriangle } from 'lucide-react';
import { useSchema } from '../lib/schema';
import FormField from './FormField';
import InfoTooltip from './InfoTooltip';
import NumberInput from './NumberInput';

// Enum lists (roles, capacities, strategies) come from GET /api/meta/schema so
// the form offers exactly what the gateway and CRD accept.

const FN_LABEL = 'block text-[12px] text-surface-450 mb-1';

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
  const schema = useSchema();
  const ROLES = [{ value: '', label: '— select role —' }, ...(schema?.node.roles ?? [])];
  const CAPACITIES = schema?.node.capacities ?? [];
  const STRATEGIES = schema?.node.balancingStrategies ?? [];

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
        <button type="button" onClick={onRemove} disabled={!canRemove} aria-label={`Remove node ${index + 1}`} title="Remove node" className="p-1.5 text-surface-400 hover:text-red-400 disabled:opacity-30">
          <Trash2 className="w-4 h-4" />
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <FormField
          label="Node ID"
          labelClassName="block text-xs font-medium text-surface-400 mb-1 flex items-center gap-1"
          labelExtra={node._locked && <Lock className="w-3 h-3 text-surface-450" title="nodeID is immutable on existing nodes (keys the libp2p Secret)" />}
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
          {node._originalRole && node.role !== node._originalRole && (
            <p role="status" className="mt-1.5 flex items-start gap-1 text-xs text-amber-400">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" aria-hidden="true" />
              <span>Wipes this node's k3s and everything installed on it, then reprovisions for the new role.</span>
            </p>
          )}
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
          <input type="password" className="input py-2 text-sm" value={node.password} onChange={(e) => onUpdate({ password: e.target.value })} required />
        </FormField>
      </div>

      {node.role === 'dfaas-worker' && (
        <>
          <FormField label="Balancing Strategy">
            <select className="input py-2 text-sm" value={node.balancingStrategy} onChange={(e) => onUpdate({ balancingStrategy: e.target.value })}>
              {STRATEGIES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </FormField>

          <div className="border-t border-surface-700/50 pt-3">
            <div className="flex items-center justify-between mb-2">
              <span className="block text-xs font-medium text-surface-400">Functions ({node.functions.length})</span>
            </div>
            <div className="space-y-2">
              {node.functions.map((fn, fIdx) => (
                <div key={fIdx} className="grid grid-cols-12 gap-2 items-end">
                  <div className="col-span-3">
                    <label className={FN_LABEL} htmlFor={`name-${index}-${fIdx}`}>Name <InfoTooltip text="OpenFaaS function name. Forms the invocation path /function/<name> on the node's HAProxy entrypoint (:30080) and is the key the dfaas-agent routes on." /></label>
                    <input type="text" id={`name-${index}-${fIdx}`} className="input py-1.5 text-xs" value={fn.name} onChange={(e) => onUpdateFunction(fIdx, { name: e.target.value })} required />
                  </div>
                  <div className="col-span-3">
                    <label className={FN_LABEL} htmlFor={`image-${index}-${fIdx}`}>Image <InfoTooltip text="Container image deployed as the function (e.g. ghcr.io/isired01/dfaas-imgproc:latest). Must match the node's CPU architecture (use a multi-arch image)." /></label>
                    <input type="text" id={`image-${index}-${fIdx}`} className="input py-1.5 text-xs" value={fn.image} onChange={(e) => onUpdateFunction(fIdx, { image: e.target.value })} required />
                  </div>
                  <div className="col-span-1">
                    <label className={FN_LABEL} htmlFor={`execTimeout-${index}-${fIdx}`}>Exec(s) <InfoTooltip text="Execution timeout in seconds: the longest a single invocation may run before OpenFaaS (of-watchdog) kills it." /></label>
                    <NumberInput id={`execTimeout-${index}-${fIdx}`} className="input py-1.5 text-xs" value={fn.execTimeout} onChange={(v) => onUpdateFunction(fIdx, { execTimeout: v })} />
                  </div>
                  <div className="col-span-1">
                    <label className={FN_LABEL} htmlFor={`maxInflight-${index}-${fIdx}`}>Max <InfoTooltip text="Max in-flight: how many requests the function handles concurrently. Beyond this OpenFaaS queues/rejects, capping load on the node." /></label>
                    <NumberInput id={`maxInflight-${index}-${fIdx}`} className="input py-1.5 text-xs" value={fn.maxInflight} onChange={(v) => onUpdateFunction(fIdx, { maxInflight: v })} />
                  </div>
                  <div className={isRecalc ? 'col-span-2' : 'col-span-3'}>
                    <label className={FN_LABEL} htmlFor={`timeoutMs-${index}-${fIdx}`}>Timeout(ms) <InfoTooltip text="Per-request timeout in milliseconds, exposed to the dfaas-agent as the dfaas.timeout_ms label and used for routing/SLA decisions." /></label>
                    <NumberInput id={`timeoutMs-${index}-${fIdx}`} className="input py-1.5 text-xs" value={fn.timeoutMs} onChange={(v) => onUpdateFunction(fIdx, { timeoutMs: v })} />
                  </div>
                  {isRecalc && (
                    <div className="col-span-1">
                      <label className={FN_LABEL} htmlFor={`maxRate-${index}-${fIdx}`}>Rate(r/s) <InfoTooltip text="Max sustainable requests/sec for this function, emitted as the dfaas.maxrate label. Required by recalcstrategy for rate-based load balancing (default 100, min 1)." /></label>
                      <NumberInput id={`maxRate-${index}-${fIdx}`} className="input py-1.5 text-xs" value={fn.maxRate} onChange={(v) => onUpdateFunction(fIdx, { maxRate: v })} />
                    </div>
                  )}
                  <div className="col-span-1">
                    <button type="button" onClick={() => onRemoveFunction(fIdx)} aria-label={`Remove function ${fIdx + 1}`} title="Remove function" className="p-1.5 text-surface-400 hover:text-red-400">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-2 flex justify-end">
              <button type="button" onClick={onAddFunction} className="text-[12px] text-dfaas-400 hover:text-dfaas-300 font-medium">
                + Add Function
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
