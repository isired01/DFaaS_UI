import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { ArrowLeft, Play, Info } from 'lucide-react';
import { createLoadTest, fetchEnvironment } from '../api/client';
import { newScenario, ensureScenarioIds } from '../components/K6ScenariosEditor';
import { generateK6Script } from '../lib/k6Generator';
import MetricsEditor, { DEFAULT_METRICS, emptyMetric } from '../components/MetricsEditor';
import { parseMetricsCsv } from '../lib/metricsCsv';
import { formatGoDuration, perNodeTotalMs } from '../lib/duration';
import NodeLoadConfig, { SOURCE_GENERATE, SOURCE_RAW } from '../components/NodeLoadConfig';
import LoadingSpinner from '../components/LoadingSpinner';
import ErrorAlert from '../components/ErrorAlert';
import SubmitButton from '../components/SubmitButton';

// Go duration grammar, kept in sync by hand with the CRD pattern on
// spec.perNodeLoad[].duration and spec.metricsExport.step. ASCII only: the CRD
// pattern deliberately omits the 'µs' spelling.
const GO_DURATION_RE = /^([0-9]+(\.[0-9]+)?(ns|us|ms|s|m|h))+$/;

function defaultPerNode() {
  return {
    enabled: false,
    vus: 5,
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
// build parses fine but can be missing whole keys (e.g. `scenarios`), which used
// to take the page down to the route ErrorBoundary until the user cleared
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

        // Duration is derived for generated scripts and typed only for raw ones.
        // k6 never reads the CRD field either way (the operator just copies it
        // onto an unread annotation), so its only real job is to be truthful
        // enough to drive the progress bar.
        let duration;
        if (draft.source === SOURCE_RAW) {
          if (!draft.duration) throw new Error(`Node '${nodeID}' needs a duration`);
          // Mirrors the CRD pattern on spec.perNodeLoad[].duration (source of truth:
          // DFaaSOperator api/v1/loadtest_types.go). Checked here so "5 minutes"
          // fails inline instead of coming back as a raw API-server 422.
          if (!GO_DURATION_RE.test(draft.duration)) {
            throw new Error(`Node '${nodeID}': duration must be a Go duration like '30s', '5m' or '1h30m' (got '${draft.duration}')`);
          }
          duration = draft.duration;
        } else {
          // Also the only validation stage durations get: they live inside the
          // generated script, so neither the CRD nor the API server can check them.
          const totalMs = perNodeTotalMs(draft.scenarios);
          if (totalMs === null || totalMs <= 0) {
            throw new Error(`Node '${nodeID}': cannot compute the run length — every scenario needs a valid startTime and stage durations like '30s' or '1m30s'`);
          }
          duration = formatGoDuration(totalMs);
        }

        let script = '';
        if (draft.source === SOURCE_RAW) {
          script = draft.rawScript || '';
          if (!script.trim()) throw new Error(`Node '${nodeID}' has no raw script`);
        } else {
          if (!draft.scenarios || draft.scenarios.length === 0) throw new Error(`Node '${nodeID}' has no scenarios`);
          // Names key the generated `scenarios` object: a duplicate is legal JS
          // but the later entry overwrites the earlier one, silently dropping a
          // whole scenario from the test.
          const seenNames = new Set();
          for (const s of draft.scenarios) {
            const scenName = (s.name || '').trim();
            if (!scenName) throw new Error(`Node '${nodeID}' has a scenario with an empty name`);
            if (seenNames.has(scenName)) throw new Error(`Node '${nodeID}' has two scenarios named '${scenName}' — scenario names must be unique`);
            seenNames.add(scenName);
            if (!s.targetURL) throw new Error(`Node '${nodeID}' scenario '${scenName}' missing targetURL`);
            if (!s.preAllocatedVUs || s.preAllocatedVUs < 1) throw new Error(`Node '${nodeID}' scenario '${scenName}' needs preAllocatedVUs >= 1`);
            if (!s.maxVUs || s.maxVUs < 1) throw new Error(`Node '${nodeID}' scenario '${scenName}' needs maxVUs >= 1`);
            if (s.headers) {
              let parsedHeaders;
              try { parsedHeaders = JSON.parse(s.headers); } catch { throw new Error(`Node '${nodeID}' scenario '${scenName}' has invalid headers JSON`); }
              // Parseable is not enough: `null` and `[]` are valid JSON but not
              // header maps, and the generator splices the text in verbatim.
              if (parsedHeaders === null || typeof parsedHeaders !== 'object' || Array.isArray(parsedHeaders)) {
                throw new Error(`Node '${nodeID}' scenario '${scenName}': headers must be a JSON object like {"Content-Type": "application/json"}`);
              }
            }
          }
          script = generateK6Script(draft.scenarios);
        }

        perNodeLoad.push({
          nodeID,
          vus: parseInt(draft.vus) || 1,
          duration,
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
        syncStart,
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
          Name: <code className="text-surface-400">lt-{envName}-&lt;timestamp&gt;{nameSuffix.trim() ? `-${nameSuffix.trim()}` : ''}</code> (sanitized to lowercase DNS-1123)
        </p>
      </div>

      <div className="p-4 rounded-xl bg-surface-800/50 border border-surface-700/50 flex items-center gap-3">
        <Info className="w-5 h-5 text-surface-400 flex-shrink-0" />
        <span className="text-sm text-surface-300">
          Load tests are created as <strong>drafts</strong>. Click <strong>Start</strong> on the load test detail page once the environment is <strong>Ready</strong> (or <strong>Degraded</strong>) to dispatch k6.
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
          All generators wait for a GO signal and start together (~250ms skew). Requires k6 VMs to reach the management node on port 30901.
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
