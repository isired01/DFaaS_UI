import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { ArrowLeft, Play, Info, Plus, Trash2, Upload, Wand2, FileCode, Server, BarChart3 } from 'lucide-react';
import { createLoadTest, fetchEnvironment } from '../api/client';
import K6ScenariosEditor, { newScenario } from '../components/K6ScenariosEditor';
import { generateK6Script } from '../lib/k6Generator';

const SOURCE_GENERATE = 'generate';
const SOURCE_RAW = 'raw';

const METRIC_TYPES = [
  { value: 'raw',           label: 'Metrica Grezza' },
  { value: 'custom-promql', label: 'Query PromQL Custom' },
];

function emptyMetric() {
  return { type: 'custom-promql', metricName: '', query: '', comment: '' };
}

const DEFAULT_METRICS = [
  { type: 'custom-promql', metricName: 'cpu_dfaas_pods',    query: 'sum(rate(container_cpu_usage_seconds_total{pod=~"dfaas-node-.*"}[1m])) by (pod)', comment: 'CPU rate per dFaaS pod' },
  { type: 'custom-promql', metricName: 'memory_dfaas_pods', query: 'sum(container_memory_working_set_bytes{pod=~"dfaas-node-.*"}) by (pod)',          comment: 'Working set memory per dFaaS pod' },
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
  const [metrics, setMetrics] = useState(DEFAULT_METRICS);
  const [step, setStep] = useState('15s');
  const [driveEnabled, setDriveEnabled] = useState(false);
  const [driveFolderID, setDriveFolderID] = useState('');
  const [driveSecretRef, setDriveSecretRef] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [cooldown, setCooldown] = useState(false);
  const [startAt, setStartAt] = useState('');
  const [submitMode, setSubmitMode] = useState('draft');

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

  const addMetric = () => setMetrics([...metrics, emptyMetric()]);
  const removeMetric = (i) => setMetrics(metrics.filter((_, idx) => idx !== i));
  const updateMetric = (i, patch) => setMetrics(metrics.map((m, idx) => idx === i ? { ...m, ...patch } : m));

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const cleanMetrics = metrics
        .map(m => ({
          type: m.type,
          metricName: (m.metricName || '').trim(),
          query: (m.query || '').trim(),
          comment: (m.comment || '').trim(),
        }))
        .filter(m => m.query || m.metricName);
      if (cleanMetrics.length === 0) throw new Error('At least one metric row is required');
      cleanMetrics.forEach((m, i) => {
        if (m.type !== 'raw' && m.type !== 'custom-promql') {
          throw new Error(`metrics[${i}]: invalid type`);
        }
        if (!m.query) throw new Error(`metrics[${i}]: query is required`);
        if (m.type === 'custom-promql' && !m.metricName) {
          throw new Error(`metrics[${i}]: metric name is required for 'Query PromQL Custom'`);
        }
      });
      const nameCounts = cleanMetrics.reduce((acc, m) => {
        if (m.metricName) acc[m.metricName] = (acc[m.metricName] || 0) + 1;
        return acc;
      }, {});
      const dupes = Object.keys(nameCounts).filter(n => nameCounts[n] > 1);
      if (dupes.length > 0) {
        // Warn-only per contract; do not block.
        console.warn(`[metrics] duplicate metricName(s):`, dupes);
      }

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
        metrics: cleanMetrics.map(m => {
          const out = { type: m.type, query: m.query };
          if (m.metricName) out.metricName = m.metricName;
          if (m.comment) out.comment = m.comment;
          return out;
        }),
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
      payload.suspended = true;

      if (submitMode === 'schedule') {
        if (!startAt) throw new Error('Pick a start time or switch to Save as Draft');
        const d = new Date(startAt);
        if (isNaN(d.getTime())) throw new Error('startAt is not a valid timestamp');
        if (d.getTime() < Date.now()) throw new Error('startAt must be in the future');
        payload.startAt = d.toISOString();
      }

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

      <div className="p-4 rounded-xl bg-surface-800/50 border border-surface-700/50 flex items-center gap-3">
        <Info className="w-5 h-5 text-surface-400 flex-shrink-0" />
        <span className="text-sm text-surface-300">
          Load tests are created as <strong>drafts</strong>. Click <strong>Start</strong> on the load test detail page once the environment is <strong>Ready</strong> to dispatch k6.
        </span>
      </div>

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

        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-[10px] text-surface-500 uppercase tracking-wider">
                <th className="py-1.5 px-2 w-[18%]">Tipo</th>
                <th className="py-1.5 px-2 w-[22%]">Nome metrica</th>
                <th className="py-1.5 px-2 w-[40%]">Query PromQL</th>
                <th className="py-1.5 px-2 w-[18%]">Commento</th>
                <th className="py-1.5 px-2 w-[2%]"></th>
              </tr>
            </thead>
            <tbody>
              {metrics.map((m, i) => {
                const isCustom = m.type === 'custom-promql';
                return (
                  <tr key={i} className="align-top">
                    <td className="py-1 px-2">
                      <select
                        className="input py-1.5 text-xs"
                        value={m.type}
                        onChange={(e) => updateMetric(i, { type: e.target.value })}
                      >
                        {METRIC_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                      </select>
                    </td>
                    <td className="py-1 px-2">
                      <input
                        type="text"
                        className="input py-1.5 text-xs"
                        value={m.metricName}
                        onChange={(e) => updateMetric(i, { metricName: e.target.value })}
                        placeholder={isCustom ? 'required' : '(defaults to query value)'}
                        required={isCustom}
                      />
                    </td>
                    <td className="py-1 px-2">
                      <input
                        type="text"
                        className="input py-1.5 text-xs font-mono"
                        value={m.query}
                        onChange={(e) => updateMetric(i, { query: e.target.value })}
                        placeholder={isCustom ? 'sum(rate(...))' : 'haproxy_backend_http_requests_total'}
                        required
                      />
                    </td>
                    <td className="py-1 px-2">
                      <input
                        type="text"
                        className="input py-1.5 text-xs"
                        value={m.comment}
                        onChange={(e) => updateMetric(i, { comment: e.target.value })}
                        placeholder="optional"
                      />
                    </td>
                    <td className="py-1 px-2">
                      <button
                        type="button"
                        onClick={() => removeMetric(i)}
                        disabled={metrics.length === 1}
                        className="p-1.5 text-surface-500 hover:text-red-400 disabled:opacity-30"
                        title={metrics.length === 1 ? 'At least one metric required' : 'Remove row'}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="flex justify-end mt-2">
            <button type="button" onClick={addMetric} className="btn-secondary text-xs px-3 py-1.5">
              <Plus className="w-3.5 h-3.5" />Aggiungi Riga
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

      <div className="flex flex-col gap-3">
        {submitMode === 'schedule' && (
          <div className="glass-card p-4 space-y-2">
            <label className="block text-xs font-medium text-surface-400">Start at</label>
            <input
              type="datetime-local"
              value={startAt}
              onChange={(e) => setStartAt(e.target.value)}
              className="input py-2 text-sm w-fit"
              required
            />
            <p className="text-xs text-surface-400">
              Time is sent as UTC. Will only fire while the load test is saved as draft.
            </p>
          </div>
        )}
        <div className="flex items-center justify-end gap-3">
          <Link to={`/environments/${namespace}/${envName}`} className="btn-secondary">Cancel</Link>
          <select
            value={submitMode}
            onChange={(e) => {
              const v = e.target.value;
              setSubmitMode(v);
              if (v === 'draft') setStartAt('');
            }}
            className="input py-2 text-sm w-44"
            disabled={submitting || cooldown}
          >
            <option value="draft">Save as Draft</option>
            <option value="schedule">Schedule start</option>
          </select>
          <button type="submit" disabled={submitting || cooldown} className="btn-primary">
            {submitting ? <><div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />Saving...</>
              : cooldown ? <>Cooling down...</>
              : <><Play className="w-4 h-4" />Confirm</>}
          </button>
        </div>
      </div>
    </form>
  );
}
