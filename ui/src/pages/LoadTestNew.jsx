import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { ArrowLeft, Play, Info } from 'lucide-react';
import { createLoadTest, fetchEnvironment } from '../api/client';
import { newScenario } from '../components/K6ScenariosEditor';
import { generateK6Script } from '../lib/k6Generator';
import MetricsEditor, { DEFAULT_METRICS, emptyMetric } from '../components/MetricsEditor';
import { parseMetricsCsv } from '../lib/metricsCsv';
import NodeLoadConfig, { SOURCE_GENERATE, SOURCE_RAW } from '../components/NodeLoadConfig';

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
  const [nameSuffix, setNameSuffix] = useState('');
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
  const handleImportMetricsCsv = async (file) => {
    try {
      const { metrics: parsed, errors } = parseMetricsCsv(await file.text());
      if (errors.length) { setError(`CSV import failed:\n${errors.join('\n')}`); return; }
      setMetrics(parsed); // replace the current rows with the file contents
      setError(null);
    } catch (e) {
      setError(`Could not read CSV: ${e.message}`);
    }
  };

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
          throw new Error(`metrics[${i}]: metric name is required for 'Custom PromQL query'`);
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

      const payload = {
        namespace,
        targetEnvironment: envName,
        perNodeLoad,
        metricsExport,
      };
      if (nameSuffix.trim()) payload.nameSuffix = nameSuffix.trim();
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

      <div>
        <label className="block text-xs font-medium text-surface-400 mb-1">Name suffix (optional)</label>
        <input
          type="text"
          className="input py-2 text-sm md:w-1/2"
          value={nameSuffix}
          onChange={(e) => setNameSuffix(e.target.value)}
          placeholder="e.g. baseline, run-2"
        />
        <p className="text-[10px] text-surface-500 mt-1">
          Name: <code className="text-surface-400">lt-{envName}-&lt;timestamp&gt;{nameSuffix.trim() ? `-${nameSuffix.trim()}` : ''}</code> (sanitized to lowercase DNS-1123)
        </p>
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
      ) : k6Statuses.map((node) => (
        <NodeLoadConfig
          key={node.nodeID}
          node={node}
          draft={perNode[node.nodeID] || defaultPerNode()}
          onUpdate={updateNode}
          onFile={handleFile}
          availableUrls={availableUrls}
          envNs={namespace}
          envName={envName}
        />
      ))}

      <MetricsEditor
        metrics={metrics}
        onAdd={addMetric}
        onRemove={removeMetric}
        onUpdate={updateMetric}
        onImportCsv={handleImportMetricsCsv}
        step={step}
        onStepChange={setStep}
        environment={environment}
      />

      {error && <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-sm whitespace-pre-line">{error}</div>}

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
