import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { ArrowLeft, Play, AlertTriangle, Plus, Trash2, Upload, Wand2, FileCode, Server, BarChart3 } from 'lucide-react';
import { createLoadTest, fetchEnvironment } from '../api/client';
import K6ScenariosEditor, { newScenario } from '../components/K6ScenariosEditor';
import { generateK6Script } from '../lib/k6Generator';

const SOURCE_GENERATE = 'generate';
const SOURCE_RAW = 'raw';

const DEFAULT_QUERIES = [
  'sum(rate(container_cpu_usage_seconds_total{pod=~"dfaas-node-.*"}[1m])) by (pod)',
  'sum(container_memory_working_set_bytes{pod=~"dfaas-node-.*"}) by (pod)',
];

function defaultPerNode() {
  return {
    enabled: false,
    vus: 5,
    duration: '30s',
    source: SOURCE_GENERATE,
    scenarios: [newScenario(0)],
    rawScript: '',
  };
}

function storageKeyFor(ns, env, nodeID) {
  return `loadtest_draft_${ns}_${env}_${nodeID}`;
}

export default function LoadTestNew() {
  const { namespace, name: envName } = useParams();
  const navigate = useNavigate();
  const [environment, setEnvironment] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [perNode, setPerNode] = useState({});
  const [queries, setQueries] = useState(DEFAULT_QUERIES);
  const [step, setStep] = useState('15s');
  const [driveEnabled, setDriveEnabled] = useState(false);
  const [driveFolderID, setDriveFolderID] = useState('');
  const [driveSecretRef, setDriveSecretRef] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [cooldown, setCooldown] = useState(false);
  const [saveAsDraft, setSaveAsDraft] = useState(false);

  useEffect(() => {
    fetchEnvironment(namespace, envName)
      .then(env => {
        setEnvironment(env);
        const initial = {};
        const k6Statuses = env.k6Nodes && env.k6Nodes.length > 0
          ? env.k6Nodes
          : (env.nodes || []).filter(n => n.role === 'k6-load-generator').map(n => ({ nodeID: n.nodeID, ipAddress: n.ipAddress }));
        k6Statuses.forEach(n => {
          const saved = localStorage.getItem(storageKeyFor(namespace, envName, n.nodeID));
          if (saved) {
            try { initial[n.nodeID] = JSON.parse(saved); return; } catch { /* fall through */ }
          }
          initial[n.nodeID] = defaultPerNode();
        });
        setPerNode(initial);
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, [namespace, envName]);

  useEffect(() => {
    Object.entries(perNode).forEach(([nodeID, draft]) => {
      localStorage.setItem(storageKeyFor(namespace, envName, nodeID), JSON.stringify(draft));
    });
  }, [perNode, namespace, envName]);

  const availableUrls = useMemo(() => {
    const urls = [];
    (environment?.nodes || []).forEach(n => {
      if (n.role !== 'dfaas-worker') return;
      (n.functions || []).forEach(fn => {
        urls.push({
          url: `http://${n.ipAddress}:30080/function/${fn.name}`,
          label: `${n.nodeID} — ${fn.name}`,
        });
      });
    });
    return urls;
  }, [environment]);

  const updateNode = (nodeID, patch) => setPerNode(prev => ({ ...prev, [nodeID]: { ...prev[nodeID], ...patch } }));

  const handleFile = (nodeID, file) => {
    if (!file || !file.name.endsWith('.js')) {
      setError('Script file must end with .js');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => updateNode(nodeID, { rawScript: reader.result, source: SOURCE_RAW });
    reader.readAsText(file);
  };

  const addQuery = () => setQueries([...queries, '']);
  const removeQuery = (i) => setQueries(queries.filter((_, idx) => idx !== i));
  const updateQuery = (i, value) => setQueries(queries.map((q, idx) => idx === i ? value : q));

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      if (!saveAsDraft && environment?.phase !== 'Ready') {
        throw new Error('Environment is not Ready');
      }
      const cleanQueries = queries.map(q => q.trim()).filter(Boolean);
      if (cleanQueries.length === 0) throw new Error('At least one metrics query is required');

      const perNodeLoad = [];
      for (const [nodeID, draft] of Object.entries(perNode)) {
        if (!draft.enabled) continue;
        if (!draft.vus || draft.vus < 1) throw new Error(`Node '${nodeID}' needs vus >= 1`);
        if (!draft.duration) throw new Error(`Node '${nodeID}' needs a duration`);

        let script = '';
        if (draft.source === SOURCE_RAW) {
          script = draft.rawScript || '';
          if (!script.trim()) throw new Error(`Node '${nodeID}' has no raw script`);
        } else {
          if (!draft.scenarios || draft.scenarios.length === 0) throw new Error(`Node '${nodeID}' has no scenarios`);
          for (const s of draft.scenarios) {
            if (!s.targetURL) throw new Error(`Node '${nodeID}' scenario '${s.name}' missing targetURL`);
            if (s.headers) {
              try { JSON.parse(s.headers); } catch { throw new Error(`Node '${nodeID}' scenario '${s.name}' has invalid headers JSON`); }
            }
          }
          script = generateK6Script(draft.scenarios);
        }

        perNodeLoad.push({
          nodeID,
          vus: parseInt(draft.vus) || 1,
          duration: draft.duration,
          script,
        });
      }

      if (perNodeLoad.length === 0) throw new Error('Enable at least one k6 node and configure its load');

      const metricsExport = {
        queries: cleanQueries,
        step: step || '15s',
      };
      if (driveEnabled) {
        const folderId = driveFolderID.trim();
        const credentialsSecretRef = driveSecretRef.trim();
        if (!folderId) throw new Error('Google Drive folderId is required');
        if (!credentialsSecretRef) throw new Error('Google Drive credentialsSecretRef is required');
        metricsExport.googleDrive = { folderId, credentialsSecretRef };
      }

      const payload = {
        namespace,
        targetEnvironment: envName,
        perNodeLoad,
        metricsExport,
      };
      if (saveAsDraft) payload.suspended = true;

      const created = await createLoadTest(payload);
      setCooldown(true);
      setTimeout(() => setCooldown(false), 30000);
      navigate(`/loadtests/${created.namespace}/${created.name}`);
    } catch (err) {
      setError(err.message);
      setSubmitting(false);
    }
  };

  if (loading) return (
    <div className="flex items-center justify-center py-32">
      <div className="w-10 h-10 border-3 border-dfaas-500/30 border-t-dfaas-500 rounded-full animate-spin" />
    </div>
  );

  if (!environment) return (
    <div className="glass-card p-8 text-center border-red-500/30 bg-red-500/5">
      <p className="text-red-400">{error || 'Environment not found'}</p>
      <Link to="/" className="btn-secondary mt-4 inline-flex">← Back</Link>
    </div>
  );

  const isReady = environment.phase === 'Ready';
  const k6Statuses = environment.k6Nodes && environment.k6Nodes.length > 0
    ? environment.k6Nodes
    : (environment.nodes || []).filter(n => n.role === 'k6-load-generator');

  return (
    <form onSubmit={handleSubmit} className="space-y-6 animate-fade-in max-w-5xl mx-auto">
      <div>
        <Link to={`/environments/${namespace}/${envName}`} className="inline-flex items-center gap-1.5 text-sm text-surface-400 hover:text-white transition-colors mb-4">
          <ArrowLeft className="w-4 h-4" />Back to {envName}
        </Link>
        <h1 className="text-2xl font-bold text-white">New Load Test</h1>
        <p className="text-sm text-surface-400 mt-1">Target environment: <span className="font-mono text-dfaas-400">{namespace}/{envName}</span></p>
      </div>

      {!isReady && (
        <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-center gap-3">
          <AlertTriangle className="w-5 h-5 text-amber-400 flex-shrink-0" />
          <span className="text-sm text-amber-300">
            Environment phase is <strong>{environment.phase || 'Unknown'}</strong>. Load tests require <strong>Ready</strong>.
          </span>
        </div>
      )}

      {k6Statuses.length === 0 ? (
        <div className="glass-card p-6 text-center text-surface-400">
          No k6 generators on this environment. Add a node with role <code>k6-load-generator</code> to launch load tests.
        </div>
      ) : k6Statuses.map((node, idx) => {
        const draft = perNode[node.nodeID] || defaultPerNode();
        return (
          <div key={node.nodeID} className="glass-card p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Server className="w-5 h-5 text-amber-400" />
                <div>
                  <h2 className="text-sm font-semibold text-white">{node.nodeID}</h2>
                  <p className="text-xs text-surface-500 font-mono">{node.ipAddress}</p>
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm text-surface-300">
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  onChange={(e) => updateNode(node.nodeID, { enabled: e.target.checked })}
                />
                Enable
              </label>
            </div>

            {draft.enabled && (
              <>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-surface-400 mb-1">VUs</label>
                    <input type="number" min="1" className="input py-2 text-sm" value={draft.vus} onChange={(e) => updateNode(node.nodeID, { vus: parseInt(e.target.value) || 0 })} required />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-surface-400 mb-1">Duration (e.g. 30s, 5m)</label>
                    <input type="text" className="input py-2 text-sm" value={draft.duration} onChange={(e) => updateNode(node.nodeID, { duration: e.target.value })} required />
                  </div>
                </div>

                <div className="flex gap-1 p-1 bg-surface-900/50 rounded-xl w-fit">
                  <button type="button" onClick={() => updateNode(node.nodeID, { source: SOURCE_GENERATE })} className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${draft.source === SOURCE_GENERATE ? 'bg-dfaas-600/30 text-dfaas-400 border border-dfaas-500/30' : 'text-surface-400 hover:text-white'}`}>
                    <Wand2 className="w-3.5 h-3.5" />Generate from scenarios
                  </button>
                  <button type="button" onClick={() => updateNode(node.nodeID, { source: SOURCE_RAW })} className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${draft.source === SOURCE_RAW ? 'bg-dfaas-600/30 text-dfaas-400 border border-dfaas-500/30' : 'text-surface-400 hover:text-white'}`}>
                    <FileCode className="w-3.5 h-3.5" />Paste raw JS
                  </button>
                </div>

                {draft.source === SOURCE_GENERATE ? (
                  <K6ScenariosEditor
                    scenarios={draft.scenarios}
                    onChange={(scenarios) => updateNode(node.nodeID, { scenarios })}
                    availableUrls={availableUrls}
                  />
                ) : (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <label htmlFor={`raw-file-${node.nodeID}`} className="btn-secondary text-xs px-3 py-1.5 cursor-pointer">
                        <Upload className="w-3.5 h-3.5" />Upload .js
                      </label>
                      <input id={`raw-file-${node.nodeID}`} type="file" accept=".js" className="hidden" onChange={(e) => e.target.files[0] && handleFile(node.nodeID, e.target.files[0])} />
                      <span className="text-[10px] text-surface-500">or paste below</span>
                    </div>
                    <textarea
                      className="input py-2 text-xs font-mono h-48"
                      value={draft.rawScript}
                      onChange={(e) => updateNode(node.nodeID, { rawScript: e.target.value })}
                      placeholder="import http from 'k6/http';&#10;export default function() { http.get('...'); }"
                    />
                  </div>
                )}
              </>
            )}
          </div>
        );
      })}

      <div className="glass-card p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-surface-300 uppercase tracking-wider flex items-center gap-2">
            <BarChart3 className="w-4 h-4" />Metrics Export
          </h2>
        </div>

        <div className="space-y-2">
          {queries.map((q, i) => (
            <div key={i} className="flex items-center gap-2">
              <input type="text" placeholder="k6_http_req_duration" className="input py-1.5 text-xs flex-1" value={q} onChange={(e) => updateQuery(i, e.target.value)} />
              <button type="button" onClick={() => removeQuery(i)} disabled={queries.length === 1} className="p-1.5 text-surface-500 hover:text-red-400 disabled:opacity-30">
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
          <div className="flex justify-end">
            <button type="button" onClick={addQuery} className="btn-secondary text-xs px-3 py-1.5">
              <Plus className="w-3.5 h-3.5" />Add Query
            </button>
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-surface-400 mb-1">Step</label>
          <input type="text" className="input py-2 text-sm w-32" value={step} onChange={(e) => setStep(e.target.value)} placeholder="15s" />
        </div>

        <div className="border-t border-surface-700/50 pt-4">
          <label className="flex items-center gap-2 text-sm text-surface-300">
            <input type="checkbox" checked={driveEnabled} onChange={(e) => setDriveEnabled(e.target.checked)} />
            Export to Google Drive
          </label>
          {driveEnabled && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
              <div>
                <label className="block text-xs font-medium text-surface-400 mb-1">Folder ID</label>
                <input type="text" className="input py-2 text-sm" value={driveFolderID} onChange={(e) => setDriveFolderID(e.target.value)} placeholder="1AbCdEf..." required />
              </div>
              <div>
                <label className="block text-xs font-medium text-surface-400 mb-1">Credentials Secret</label>
                <input type="text" className="input py-2 text-sm" value={driveSecretRef} onChange={(e) => setDriveSecretRef(e.target.value)} placeholder="gdrive-credentials" required />
                <p className="text-[10px] text-surface-500 mt-1">Name of a Secret (key: <code>credentials.json</code>) in the same namespace.</p>
              </div>
            </div>
          )}
        </div>
      </div>

      {error && <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-sm">{error}</div>}

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <label className="flex items-center gap-2 text-sm text-surface-300 cursor-pointer" title="Save the LoadTest as a draft. It will not run until you click Start from its detail page.">
          <input type="checkbox" checked={saveAsDraft} onChange={(e) => setSaveAsDraft(e.target.checked)} />
          Save as Draft <span className="text-[10px] text-surface-500">(skip Ready gate, start manually later)</span>
        </label>
        <div className="flex items-center gap-3">
          <Link to={`/environments/${namespace}/${envName}`} className="btn-secondary">Cancel</Link>
          <button type="submit" disabled={(!saveAsDraft && !isReady) || submitting || cooldown} className="btn-primary">
            {submitting ? <><div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />{saveAsDraft ? 'Saving...' : 'Launching...'}</>
              : cooldown ? <>Cooling down...</>
              : saveAsDraft ? <><Play className="w-4 h-4" />Save as Draft</>
              : <><Play className="w-4 h-4" />Launch Load Test</>}
          </button>
        </div>
      </div>
    </form>
  );
}
