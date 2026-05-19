import { useState, useEffect } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Plus, Trash2, Server, Network, Save, Lock } from 'lucide-react';
import { createEnvironment, fetchEnvironment, updateEnvironment } from '../api/client';

const BALANCING_STRATEGIES = [
  { value: 'staticstrategy',     label: 'Static — fixed routing weights' },
  { value: 'recalcstrategy',     label: 'Recalc — rate-based (requires maxRate per fn)' },
  { value: 'alllocalstrategy',   label: 'All Local — keep traffic local' },
  { value: 'nodemarginstrategy', label: 'Node Margin (experimental)' },
  { value: 'rlagentstrategy',    label: 'RL Agent (experimental)' },
];

const CAPACITIES = ['LOW', 'MEDIUM', 'HIGH'];
const ROLES = [
  { value: '',                  label: '— select role —' },
  { value: 'dfaas-worker',      label: 'dFaaS Worker' },
  { value: 'k6-load-generator', label: 'k6 Load Generator' },
];

function emptyNode() {
  return {
    nodeID: '',
    ipAddress: '',
    role: '',
    capacity: 'MEDIUM',
    username: '',
    password: '',
    balancingStrategy: '',
    functions: [],
  };
}

function emptyFunction() {
  return { name: '', image: '', execTimeout: 5, maxInflight: 400, timeoutMs: 6000, maxRate: 100 };
}

function emptyLink() {
  return { nodeA: '', nodeB: '', latencyMs: 10 };
}

export default function EnvironmentNew({ mode = 'create' }) {
  const navigate = useNavigate();
  const params = useParams();
  const isEdit = mode === 'edit';
  const [namespace, setNamespace] = useState(isEdit ? (params.namespace || '') : 'default');
  const [name, setName] = useState(isEdit ? (params.name || '') : '');
  const [cleanupOnDelete, setCleanupOnDelete] = useState(false);
  const [nodes, setNodes] = useState([emptyNode()]);
  const [links, setLinks] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [loadingEnv, setLoadingEnv] = useState(isEdit);

  useEffect(() => {
    if (!isEdit) return;
    fetchEnvironment(params.namespace, params.name)
      .then(env => {
        setCleanupOnDelete(!!env.cleanupOnDelete);
        const prefilledNodes = (env.nodes || []).map(n => ({
          nodeID: n.nodeID || '',
          ipAddress: n.ipAddress || '',
          role: n.role || '',
          capacity: n.capacity || 'MEDIUM',
          username: n.username || '',
          password: n.password || '',
          balancingStrategy: n.balancingStrategy || '',
          functions: (n.functions || []).map(fn => ({
            name: fn.name || '',
            image: fn.image || '',
            execTimeout: fn.execTimeout ?? 5,
            maxInflight: fn.maxInflight ?? 400,
            timeoutMs: fn.timeoutMs ?? 6000,
            maxRate: fn.maxRate ?? 100,
          })),
          _locked: true,
        }));
        setNodes(prefilledNodes.length > 0 ? prefilledNodes : [emptyNode()]);
        setLinks((env.topology?.links || []).map(l => ({
          nodeA: l.nodeA, nodeB: l.nodeB, latencyMs: l.latencyMs ?? 10,
        })));
      })
      .catch(err => setError(err.message))
      .finally(() => setLoadingEnv(false));
  }, [isEdit, params.namespace, params.name]);

  const updateNode = (i, patch) => setNodes(nodes.map((n, idx) => idx === i ? { ...n, ...patch } : n));
  const addNode = () => setNodes([...nodes, emptyNode()]);
  const removeNode = (i) => setNodes(nodes.filter((_, idx) => idx !== i));

  const addFunction = (nodeIdx) => updateNode(nodeIdx, { functions: [...nodes[nodeIdx].functions, emptyFunction()] });
  const removeFunction = (nodeIdx, fnIdx) => updateNode(nodeIdx, { functions: nodes[nodeIdx].functions.filter((_, i) => i !== fnIdx) });
  const updateFunction = (nodeIdx, fnIdx, patch) => updateNode(nodeIdx, {
    functions: nodes[nodeIdx].functions.map((f, i) => i === fnIdx ? { ...f, ...patch } : f),
  });

  const addLink = () => setLinks([...links, emptyLink()]);
  const removeLink = (i) => setLinks(links.filter((_, idx) => idx !== i));
  const updateLink = (i, patch) => setLinks(links.map((l, idx) => idx === i ? { ...l, ...patch } : l));

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      if (!name) throw new Error('Environment name is required');
      if (nodes.length === 0) throw new Error('At least one node is required');
      const NODE_ID_RE = /^[-._a-zA-Z0-9]+$/;
      const seen = new Set();
      nodes.forEach((n, idx) => {
        const nid = (n.nodeID || '').trim();
        if (!nid) throw new Error(`Node #${idx + 1} is missing a nodeID`);
        if (!NODE_ID_RE.test(nid)) throw new Error(`Node '${nid}' nodeID must match [-._a-zA-Z0-9]+ (no spaces)`);
        if (seen.has(nid)) throw new Error(`Duplicate nodeID '${nid}'`);
        seen.add(nid);
        if (!n.role) throw new Error(`Node '${nid}' is missing a role`);
        if (!(n.ipAddress || '').trim()) throw new Error(`Node '${nid}' is missing ipAddress`);
        if (!(n.username || '').trim()) throw new Error(`Node '${nid}' is missing username`);
        if (!n.password) throw new Error(`Node '${nid}' is missing password`);
      });

      const payload = {
        namespace,
        name,
        cleanupOnDelete,
        nodes: nodes.map(n => {
          const node = {
            nodeID: n.nodeID.trim(),
            ipAddress: n.ipAddress.trim(),
            role: n.role,
            capacity: n.capacity,
            username: n.username.trim(),
            password: n.password,
          };
          if (n.role === 'dfaas-worker') {
            node.balancingStrategy = n.balancingStrategy;
            if (n.functions.length > 0) {
              const emitMaxRate = n.balancingStrategy === 'recalcstrategy';
              node.functions = n.functions.map(f => {
                const fn = {
                  name: f.name,
                  image: f.image,
                  execTimeout: parseInt(f.execTimeout) || 0,
                  maxInflight: parseInt(f.maxInflight) || 0,
                  timeoutMs: parseInt(f.timeoutMs) || 0,
                };
                if (emitMaxRate) {
                  const maxRate = parseInt(f.maxRate);
                  fn.maxRate = Number.isFinite(maxRate) && maxRate >= 1 ? maxRate : 100;
                }
                return fn;
              });
            }
          }
          return node;
        }),
        topology: {
          links: links.map(l => ({
            nodeA: l.nodeA,
            nodeB: l.nodeB,
            latencyMs: parseInt(l.latencyMs) || 0,
          })),
        },
      };

      if (isEdit) {
        await updateEnvironment(namespace, name, {
          cleanupOnDelete: payload.cleanupOnDelete,
          nodes: payload.nodes,
          topology: payload.topology,
        });
      } else {
        await createEnvironment(payload);
      }
      navigate(`/environments/${namespace}/${name}`);
    } catch (err) {
      setError(err.message);
      setSubmitting(false);
    }
  };

  const nodeIDs = nodes.map(n => n.nodeID).filter(Boolean);

  return (
    <form onSubmit={handleSubmit} className="space-y-6 animate-fade-in max-w-5xl mx-auto">
      <div>
        <Link to="/" className="inline-flex items-center gap-1.5 text-sm text-surface-400 hover:text-white transition-colors mb-4">
          <ArrowLeft className="w-4 h-4" />Back to Environments
        </Link>
        <h1 className="text-2xl font-bold text-white">{isEdit ? `Edit Environment — ${name}` : 'New Environment'}</h1>
        <p className="text-sm text-surface-400 mt-1">
          {isEdit
            ? 'PATCH the spec. Operator restarts the FSM from ProvisioningVMs once the patch lands.'
            : 'Define the federation infrastructure and trigger provisioning.'}
        </p>
      </div>

      <div className="glass-card p-5 space-y-4">
        <h2 className="text-sm font-semibold text-surface-300 uppercase tracking-wider">Metadata</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-surface-400 mb-1">Namespace</label>
            <input type="text" className={`input ${isEdit ? 'opacity-60 cursor-not-allowed' : ''}`} value={namespace} onChange={(e) => setNamespace(e.target.value)} readOnly={isEdit} required />
          </div>
          <div>
            <label className="block text-xs font-medium text-surface-400 mb-1">Name</label>
            <input type="text" className={`input ${isEdit ? 'opacity-60 cursor-not-allowed' : ''}`} value={name} onChange={(e) => setName(e.target.value)} placeholder="env-demo" readOnly={isEdit} required />
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm text-surface-300">
          <input type="checkbox" checked={cleanupOnDelete} onChange={(e) => setCleanupOnDelete(e.target.checked)} />
          Run cleanup when environment is deleted
        </label>
      </div>

      <div className="glass-card p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-surface-300 uppercase tracking-wider flex items-center gap-2">
            <Server className="w-4 h-4" />Nodes ({nodes.length})
          </h2>
        </div>

        {nodes.map((node, i) => (
          <div key={i} className="border border-surface-700/50 rounded-xl p-4 space-y-3 bg-surface-900/30">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-white">Node #{i + 1}{node.nodeID && ` — ${node.nodeID}`}</span>
              <button type="button" onClick={() => removeNode(i)} disabled={nodes.length === 1} className="p-1.5 text-surface-500 hover:text-red-400 disabled:opacity-30">
                <Trash2 className="w-4 h-4" />
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div>
                <label className="block text-xs font-medium text-surface-400 mb-1 flex items-center gap-1">
                  Node ID
                  {node._locked && <Lock className="w-3 h-3 text-surface-500" title="nodeID is immutable on existing nodes (keys the libp2p Secret)" />}
                </label>
                <input
                  type="text"
                  className={`input py-2 text-sm ${node._locked ? 'opacity-60 cursor-not-allowed' : ''}`}
                  value={node.nodeID}
                  onChange={(e) => updateNode(i, { nodeID: e.target.value })}
                  readOnly={!!node._locked}
                  required
                  title={node._locked ? 'nodeID cannot be changed on an existing node (keys libp2p Secret)' : ''}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-surface-400 mb-1">IP Address</label>
                <input type="text" className="input py-2 text-sm" value={node.ipAddress} onChange={(e) => updateNode(i, { ipAddress: e.target.value })} placeholder="10.0.0.1" required />
              </div>
              <div>
                <label className="block text-xs font-medium text-surface-400 mb-1">Role</label>
                <select className="input py-2 text-sm" value={node.role} onChange={(e) => {
                  const role = e.target.value;
                  if (role === 'k6-load-generator') {
                    updateNode(i, { role, balancingStrategy: '', functions: [] });
                  } else if (role === 'dfaas-worker') {
                    updateNode(i, { role, balancingStrategy: node.balancingStrategy || 'recalcstrategy' });
                  } else {
                    updateNode(i, { role: '', balancingStrategy: '', functions: [] });
                  }
                }}>
                  {ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div>
                <label className="block text-xs font-medium text-surface-400 mb-1">Capacity</label>
                <select className="input py-2 text-sm" value={node.capacity} onChange={(e) => updateNode(i, { capacity: e.target.value })}>
                  {CAPACITIES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-surface-400 mb-1">Username</label>
                <input type="text" className="input py-2 text-sm" value={node.username} onChange={(e) => updateNode(i, { username: e.target.value })} required />
              </div>
              <div>
                <label className="block text-xs font-medium text-surface-400 mb-1">Password</label>
                <input type="text" className="input py-2 text-sm" value={node.password} onChange={(e) => updateNode(i, { password: e.target.value })} required />
              </div>
            </div>

            {node.role === 'dfaas-worker' && (
              <>
                <div>
                  <label className="block text-xs font-medium text-surface-400 mb-1">Balancing Strategy</label>
                  <select className="input py-2 text-sm" value={node.balancingStrategy} onChange={(e) => updateNode(i, { balancingStrategy: e.target.value })}>
                    {BALANCING_STRATEGIES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                  </select>
                </div>

                <div className="border-t border-surface-700/50 pt-3">
                  <div className="flex items-center justify-between mb-2">
                    <label className="block text-xs font-medium text-surface-400">Functions ({node.functions.length})</label>
                  </div>
                  <div className="space-y-2">
                    {node.functions.map((fn, fIdx) => (
                      <div key={fIdx} className="grid grid-cols-12 gap-2 items-end">
                        <div className="col-span-3">
                          <label className="block text-[10px] text-surface-500 mb-1">Name</label>
                          <input type="text" className="input py-1.5 text-xs" value={fn.name} onChange={(e) => updateFunction(i, fIdx, { name: e.target.value })} required />
                        </div>
                        <div className="col-span-3">
                          <label className="block text-[10px] text-surface-500 mb-1">Image</label>
                          <input type="text" className="input py-1.5 text-xs" value={fn.image} onChange={(e) => updateFunction(i, fIdx, { image: e.target.value })} required />
                        </div>
                        <div className="col-span-1">
                          <label className="block text-[10px] text-surface-500 mb-1">Exec(s)</label>
                          <input type="number" className="input py-1.5 text-xs" value={fn.execTimeout} onChange={(e) => updateFunction(i, fIdx, { execTimeout: e.target.value })} />
                        </div>
                        <div className="col-span-1">
                          <label className="block text-[10px] text-surface-500 mb-1">Max</label>
                          <input type="number" className="input py-1.5 text-xs" value={fn.maxInflight} onChange={(e) => updateFunction(i, fIdx, { maxInflight: e.target.value })} />
                        </div>
                        <div className={node.balancingStrategy === 'recalcstrategy' ? 'col-span-2' : 'col-span-3'}>
                          <label className="block text-[10px] text-surface-500 mb-1">Timeout(ms)</label>
                          <input type="number" className="input py-1.5 text-xs" value={fn.timeoutMs} onChange={(e) => updateFunction(i, fIdx, { timeoutMs: e.target.value })} />
                        </div>
                        {node.balancingStrategy === 'recalcstrategy' && (
                          <div className="col-span-1">
                            <label className="block text-[10px] text-surface-500 mb-1" title="Rate limit consumed by recalcstrategy">Rate(r/s)</label>
                            <input type="number" min="1" className="input py-1.5 text-xs" value={fn.maxRate} onChange={(e) => updateFunction(i, fIdx, { maxRate: e.target.value })} />
                          </div>
                        )}
                        <div className="col-span-1">
                          <button type="button" onClick={() => removeFunction(i, fIdx)} className="p-1.5 text-surface-500 hover:text-red-400">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="mt-2 flex justify-end">
                    <button type="button" onClick={() => addFunction(i)} className="text-[10px] text-dfaas-400 hover:text-dfaas-300 font-medium">
                      + Add Function
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        ))}
        <div className="flex justify-end">
          <button type="button" onClick={addNode} className="btn-secondary text-xs px-3 py-1.5">
            <Plus className="w-3.5 h-3.5" />Add Node
          </button>
        </div>
      </div>

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
              <select className="input py-1.5 text-xs" value={link.nodeA} onChange={(e) => updateLink(i, { nodeA: e.target.value })} required>
                <option value="">—</option>
                {nodeIDs.map(id => <option key={id} value={id}>{id}</option>)}
              </select>
            </div>
            <div className="col-span-4">
              <label className="block text-[10px] text-surface-500 mb-1">Node B</label>
              <select className="input py-1.5 text-xs" value={link.nodeB} onChange={(e) => updateLink(i, { nodeB: e.target.value })} required>
                <option value="">—</option>
                {nodeIDs.map(id => <option key={id} value={id}>{id}</option>)}
              </select>
            </div>
            <div className="col-span-3">
              <label className="block text-[10px] text-surface-500 mb-1">Latency (ms)</label>
              <input type="number" min="0" className="input py-1.5 text-xs" value={link.latencyMs} onChange={(e) => updateLink(i, { latencyMs: e.target.value })} required />
            </div>
            <div className="col-span-1">
              <button type="button" onClick={() => removeLink(i)} className="p-1.5 text-surface-500 hover:text-red-400">
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        ))}
        <div className="flex justify-end">
          <button type="button" onClick={addLink} className="btn-secondary text-xs px-3 py-1.5">
            <Plus className="w-3.5 h-3.5" />Add Link
          </button>
        </div>
      </div>

      {error && <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-sm">{error}</div>}

      <div className="flex items-center justify-end gap-3">
        <Link to="/" className="btn-secondary">Cancel</Link>
        <button type="submit" disabled={submitting || loadingEnv} className="btn-primary">
          {submitting
            ? <><div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />{isEdit ? 'Patching...' : 'Creating...'}</>
            : <><Save className="w-4 h-4" />{isEdit ? 'Save Changes' : 'Create Environment'}</>}
        </button>
      </div>
    </form>
  );
}
