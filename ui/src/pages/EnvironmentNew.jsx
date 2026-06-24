import { useState, useEffect } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Save, Database } from 'lucide-react';
import { createEnvironment, fetchEnvironment, updateEnvironment, listS3Configs } from '../api/client';
import NodeList from '../components/NodeList';
import LinkEditor from '../components/LinkEditor';
import FormField from '../components/FormField';
import ErrorAlert from '../components/ErrorAlert';
import SubmitButton from '../components/SubmitButton';

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
  const [s3ConfigName, setS3ConfigName] = useState('');
  const [availableConfigs, setAvailableConfigs] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [loadingEnv, setLoadingEnv] = useState(isEdit);

  useEffect(() => {
    listS3Configs()
      .then(setAvailableConfigs)
      .catch(() => setAvailableConfigs([]));
  }, []);

  useEffect(() => {
    if (!isEdit) return;
    fetchEnvironment(params.namespace, params.name)
      .then(env => {
        setCleanupOnDelete(!!env.cleanupOnDelete);
        setS3ConfigName(env.s3ConfigRef?.name || '');
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
      const trimmedS3 = (s3ConfigName || '').trim();
      if (trimmedS3) {
        payload.s3ConfigRef = { name: trimmedS3 };
      }

      if (isEdit) {
        const patch = {
          cleanupOnDelete: payload.cleanupOnDelete,
          nodes: payload.nodes,
          topology: payload.topology,
        };
        if (trimmedS3) {
          patch.s3ConfigRef = { name: trimmedS3 };
        }
        await updateEnvironment(namespace, name, patch);
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
          <FormField label="Namespace">
            <input type="text" className={`input ${isEdit ? 'opacity-60 cursor-not-allowed' : ''}`} value={namespace} onChange={(e) => setNamespace(e.target.value)} readOnly={isEdit} required />
          </FormField>
          <FormField label="Name">
            <input type="text" className={`input ${isEdit ? 'opacity-60 cursor-not-allowed' : ''}`} value={name} onChange={(e) => setName(e.target.value)} placeholder="env-demo" readOnly={isEdit} required />
          </FormField>
        </div>
        <label className="flex items-center gap-2 text-sm text-surface-300">
          <input type="checkbox" checked={cleanupOnDelete} onChange={(e) => setCleanupOnDelete(e.target.checked)} />
          Run cleanup when environment is deleted
        </label>
      </div>

      <div className="glass-card p-5 space-y-4">
        <NodeList
          nodes={nodes}
          onUpdateNode={updateNode}
          onAddNode={addNode}
          onRemoveNode={removeNode}
          onAddFunction={addFunction}
          onRemoveFunction={removeFunction}
          onUpdateFunction={updateFunction}
        />

        <div className="border-t border-surface-700/50 pt-4">
          <label className="block text-xs font-medium text-surface-400 mb-1 flex items-center gap-1.5">
            <Database className="w-3.5 h-3.5 text-dfaas-400" />
            S3 Configuration (optional)
          </label>
          <select
            value={s3ConfigName}
            onChange={(e) => setS3ConfigName(e.target.value)}
            className="input py-2 text-sm"
            id="s3-config-select"
          >
            <option value="">— none (CSV → stdout) —</option>
            {availableConfigs.map(cfg => (
              <option key={cfg.name} value={cfg.name}>
                {cfg.name} ({cfg.endpoint || 'AWS default'} / {cfg.region})
              </option>
            ))}
            {s3ConfigName && !availableConfigs.some(c => c.name === s3ConfigName) && (
              <option value={s3ConfigName}>{s3ConfigName} (current, not in registry)</option>
            )}
          </select>
          <p className="text-[12px] text-surface-500 mt-1">
            Every LoadTest in this environment exports its CSV to <code>s3://&lt;env-name&gt;-&lt;uid&gt;/metrics/...</code> using the chosen config.{' '}
            <Link to="/s3-configs/new" target="_blank" rel="noopener" className="text-dfaas-400 hover:text-dfaas-300">
              Create new S3 config
            </Link>
          </p>
        </div>
      </div>

      <LinkEditor
        links={links}
        nodeIDs={nodeIDs}
        onAdd={addLink}
        onRemove={removeLink}
        onUpdate={updateLink}
      />

      {error && <ErrorAlert message={error} />}

      <div className="flex items-center justify-end gap-3">
        <Link to="/" className="btn-secondary">Cancel</Link>
        <SubmitButton loading={submitting} disabled={submitting || loadingEnv} loadingLabel={isEdit ? 'Patching...' : 'Creating...'}>
          <><Save className="w-4 h-4" />{isEdit ? 'Save Changes' : 'Create Environment'}</>
        </SubmitButton>
      </div>
    </form>
  );
}
