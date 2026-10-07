import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { ArrowLeft, Play, Info } from 'lucide-react';
import { createLoadTest, fetchEnvironment } from '../api/client';
import { loadSchema } from '../lib/schema';
import { newScenario, ensureScenarioIds } from '../lib/scenarios';
import { buildLoadTestPayload } from '../lib/payloads/loadtest';
import MetricsEditor, { DEFAULT_METRICS, emptyMetric } from '../components/MetricsEditor';
import { parseMetricsCsv } from '../lib/metricsCsv';
import NodeLoadConfig, { SOURCE_GENERATE, SOURCE_RAW } from '../components/NodeLoadConfig';
import LoadingSpinner from '../components/LoadingSpinner';
import ErrorAlert from '../components/ErrorAlert';
import SubmitButton from '../components/SubmitButton';


function defaultPerNode() {
  return {
    enabled: false,
    duration: '30s',
    source: SOURCE_GENERATE,
    scenarios: [newScenario()],
    rawScript: '',
  };
}

function storageKeyFor(ns, env, nodeID) {
  return `loadtest_draft_${ns}_${env}_${nodeID}`;
}

// loadDraft restores one node's saved form state. A draft written by an older
// build parses fine but can be missing whole keys (e.g. `scenarios`), which would
// take the page down to the route ErrorBoundary until the user cleared
// localStorage by hand — so nothing is trusted beyond the shape defaultPerNode()
// declares, and scenarios get their stable id backfilled.
function loadDraft(ns, env, nodeID) {
  const base = defaultPerNode();
  let saved = null;
  try {
    const raw = localStorage.getItem(storageKeyFor(ns, env, nodeID));
    saved = raw ? JSON.parse(raw) : null;
  } catch { return base; }
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return base;
  const scenarios = Array.isArray(saved.scenarios) && saved.scenarios.length > 0
    ? ensureScenarioIds(saved.scenarios)
    : base.scenarios;
  return { ...base, ...saved, scenarios };
}

// k6NodesOf resolves the generator list: status is authoritative once populated
// (it carries the resolved kubeconfig Secret), otherwise fall back to the spec
// filtered by role.
function k6NodesOf(env) {
  if (!env) return [];
  return env.k6Nodes && env.k6Nodes.length > 0
    ? env.k6Nodes
    : (env.nodes || []).filter(n => n.role === 'k6-load-generator');
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
  const [startAt, setStartAt] = useState('');
  const [submitMode, setSubmitMode] = useState('draft');
  const [syncStart, setSyncStart] = useState(false);
  const [syncTouched, setSyncTouched] = useState(false);

  useEffect(() => {
    fetchEnvironment(namespace, envName)
      .then(setEnvironment)
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, [namespace, envName]);

  // One definition of the generator list, used both to seed the drafts below and
  // to render the per-node cards.
  const k6Nodes = useMemo(() => k6NodesOf(environment), [environment]);

  // Seed one draft per generator, restoring the saved localStorage draft when
  // there is one. The environment is fetched once, so this runs once.
  useEffect(() => {
    if (k6Nodes.length === 0) return;
    const initial = {};
    k6Nodes.forEach(n => { initial[n.nodeID] = loadDraft(namespace, envName, n.nodeID); });
    setPerNode(initial);
  }, [k6Nodes, namespace, envName]);

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

  // Count generators the user has actually enabled: synchronized start only
  // matters when two or more will run at once.
  const enabledK6Count = useMemo(
    () => Object.values(perNode).filter(d => d?.enabled).length,
    [perNode],
  );

  // Default the checkbox on when 2+ generators are enabled, but stop steering it
  // once the user has toggled it by hand.
  useEffect(() => {
    if (syncTouched) return;
    setSyncStart(enabledK6Count >= 2);
  }, [enabledK6Count, syncTouched]);

  const updateNode = (nodeID, patch) => setPerNode(prev => ({ ...prev, [nodeID]: { ...prev[nodeID], ...patch } }));

  const handleFile = (nodeID, file) => {
    if (!file || !file.name.endsWith('.js')) {
      setError('Script file must end with .js');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => updateNode(nodeID, { rawScript: reader.result, source: SOURCE_RAW });
    reader.onerror = () => setError(`Could not read '${file.name}': ${reader.error?.message || 'read failed'}`);
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
      const rules = (await loadSchema()).loadTest;
      const { payload, errors, warnings } = buildLoadTestPayload(
        { namespace, envName, metrics, perNode, step, nameSuffix, syncStart, submitMode, startAt }, rules);
      for (const w of warnings) console.warn('[loadtest]', w);
      if (errors.length > 0) throw new Error(errors[0]);
      const created = await createLoadTest(payload);
      navigate(`/loadtests/${created.namespace}/${created.name}`);
    } catch (err) {
      setError(err.message);
      setSubmitting(false);
    }
  };

  if (loading) return <LoadingSpinner />;

  if (!environment) return (
    <div className="glass-card p-8 text-center border-red-500/30 bg-red-500/5">
      <p className="text-red-400">{error || 'Environment not found'}</p>
      <Link to="/" className="btn-secondary mt-4 inline-flex">← Back</Link>
    </div>
  );

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
        <label htmlFor="lt-name-suffix" className="block text-xs font-medium text-surface-400 mb-1">Name suffix (optional)</label>
        <input
          id="lt-name-suffix"
          type="text"
          className="input py-2 text-sm md:w-1/2"
          value={nameSuffix}
          onChange={(e) => setNameSuffix(e.target.value)}
          placeholder="e.g. baseline, run-2"
        />
        <p className="text-[12px] text-surface-450 mt-1">
          Name: <code className="text-surface-400">lt-{envName}-&lt;timestamp&gt;{nameSuffix.trim() ? `-${nameSuffix.trim()}` : ''}-&lt;nonce&gt;</code> (sanitized to lowercase DNS-1123)
        </p>
      </div>

      <div className="p-4 rounded-xl bg-surface-800/50 border border-surface-700/50 flex items-center gap-3">
        <Info className="w-5 h-5 text-surface-400 flex-shrink-0" />
        <span className="text-sm text-surface-300">
          Load tests are created as <strong>drafts</strong>. Click <strong>Start</strong> on the load test detail page once the environment is <strong>Ready</strong> to dispatch k6.
        </span>
      </div>

      {k6Nodes.length === 0 ? (
        <div className="glass-card p-6 text-center text-surface-400">
          No k6 generators on this environment. Add a node with role <code>k6-load-generator</code> to launch load tests.
        </div>
      ) : k6Nodes.map((node) => (
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

      <div className="glass-card p-5">
        <label className="flex items-center gap-2 text-sm text-surface-300">
          <input
            type="checkbox"
            checked={syncStart}
            onChange={(e) => { setSyncStart(e.target.checked); setSyncTouched(true); }}
          />
          Synchronized start
        </label>
        <p className="text-[12px] text-surface-450 mt-1">
          All generators wait for a GO signal before sending load; runners can still start a few seconds apart. Requires k6 VMs to reach the management node on port 30901.
        </p>
      </div>

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

      {error && <ErrorAlert message={error} className="whitespace-pre-line" />}

      <div className="flex flex-col gap-3">
        {submitMode === 'schedule' && (
          <div className="glass-card p-4 space-y-2">
            <label htmlFor="lt-start-at" className="block text-xs font-medium text-surface-400">Start at</label>
            <input
              id="lt-start-at"
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
            aria-label="Submit mode"
            value={submitMode}
            onChange={(e) => {
              const v = e.target.value;
              setSubmitMode(v);
              if (v === 'draft') setStartAt('');
            }}
            className="input py-2 text-sm w-44"
            disabled={submitting}
          >
            <option value="draft">Save as Draft</option>
            <option value="schedule">Schedule start</option>
          </select>
          <SubmitButton loading={submitting} disabled={submitting} loadingLabel="Saving...">
            <><Play className="w-4 h-4" />Confirm</>
          </SubmitButton>
        </div>
      </div>
    </form>
  );
}
