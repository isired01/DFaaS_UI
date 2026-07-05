import { useState, useEffect } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, TestTube2, Trash2, AlertTriangle, Info, Server, BarChart3, FileCode, Download, Play, FileEdit, Ban, Loader2 } from 'lucide-react';
import { fetchLoadTest, deleteLoadTest, fetchLoadTestYAML, downloadTextAsFile, activateLoadTest, abortLoadTest, fetchEnvironment } from '../api/client';
import PhaseBadge from '../components/PhaseBadge';
import TestRunBadge from '../components/TestRunBadge';
import ScheduledStartCard from '../components/ScheduledStartCard';
import ConditionsList from '../components/ConditionsList';
import LoadingSpinner from '../components/LoadingSpinner';
import { ACTIVE_PHASES } from '../lib/constants';
import { formatDateTime } from '../lib/format';

export default function LoadTestDetail() {
  const { namespace, name } = useParams();
  const navigate = useNavigate();
  const [loadtest, setLoadtest] = useState(null);
  const [environment, setEnvironment] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [expandedScript, setExpandedScript] = useState(null);
  const [activating, setActivating] = useState(false);
  const [aborting, setAborting] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!loadtest?.startAt) return undefined;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [loadtest?.startAt]);

  useEffect(() => {
    const load = async () => {
      try {
        setError(null);
        const data = await fetchLoadTest(namespace, name);
        setLoadtest(data);
        if (data?.targetEnvironment) {
          fetchEnvironment(namespace, data.targetEnvironment)
            .then(setEnvironment)
            .catch(() => { /* non-fatal — hint just hidden */ });
        }
      } catch (err) { setError(err.message); }
      finally { setLoading(false); }
    };
    load();
    const interval = setInterval(() => {
      if (!loadtest || ACTIVE_PHASES.has(loadtest.phase)) load();
    }, 5000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [namespace, name, loadtest?.phase]);

  const handleDownloadYAML = async () => {
    try {
      const yaml = await fetchLoadTestYAML(namespace, name);
      downloadTextAsFile(yaml, `loadtest-${namespace}-${name}.yaml`, 'application/yaml');
    } catch (err) { setError(err.message); }
  };

  const handleActivate = async () => {
    if (!confirm(`Start load test '${name}' now? This will exit Draft mode and dispatch k6 jobs.`)) return;
    setActivating(true);
    try {
      await activateLoadTest(namespace, name);
      const data = await fetchLoadTest(namespace, name);
      setLoadtest(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setActivating(false);
    }
  };

  const handleAbort = async () => {
    if (!confirm(`Abort load test '${name}'? Remote k6 jobs will be terminated. The CR persists in history.`)) return;
    setAborting(true);
    try {
      await abortLoadTest(namespace, name);
      const data = await fetchLoadTest(namespace, name);
      setLoadtest(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setAborting(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm(`Delete load test '${name}'?`)) return;
    setDeleting(true);
    try {
      await deleteLoadTest(namespace, name);
      navigate('/loadtests');
    } catch (err) {
      setError(err.message);
      setDeleting(false);
    }
  };

  if (loading) return <LoadingSpinner />;

  if (error) return (
    <div className="glass-card p-8 text-center border-red-500/30 bg-red-500/5">
      <AlertTriangle className="w-10 h-10 text-red-400 mx-auto mb-3" />
      <p className="text-red-400">{error}</p>
      <Link to="/loadtests" className="btn-secondary mt-4 inline-flex">← Back to Load Tests</Link>
    </div>
  );

  if (!loadtest) return null;

  // Desired state from spec.suspended is the source of truth (Conditions[Suspended]
  // is derived and may be empty during the first reconcile after creation).
  const isDraft = loadtest.suspended === true;
  const isTerminal = ['Completed', 'Failed', 'Aborted'].includes(loadtest.phase);
  const abortRequested = loadtest.stop === true;
  const canAbort = loadtest.phase === 'Running' && !abortRequested;
  const isRunning = loadtest.phase === 'Running';
  // Tooltip on terminal Aborted: surface operator-stamped Ready=False reason=UserAborted message.
  const abortedMsg = loadtest.phase === 'Aborted'
    ? (loadtest.conditions || []).find(c => c.type === 'Ready' && c.reason === 'UserAborted')?.message || ''
    : '';
  const pendingTooltip = loadtest.phase === 'Pending'
    ? (isDraft ? 'Draft saved' : 'Waiting for Environment Ready')
    : abortedMsg;

  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <Link to={`/environments/${namespace}/${loadtest.targetEnvironment}`} className="inline-flex items-center gap-1.5 text-sm text-surface-400 hover:text-white transition-colors mb-4">
          <ArrowLeft className="w-4 h-4" />Back to {loadtest.targetEnvironment}
        </Link>
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold text-white flex items-center gap-3">
              <TestTube2 className="w-7 h-7 text-amber-400" />
              {loadtest.name}
            </h1>
            <div className="flex items-center gap-3 mt-2">
              <span className="text-xs font-mono text-surface-400 px-2 py-1 bg-surface-800/50 rounded-lg border border-surface-700/50">{loadtest.namespace}</span>
              <Link to={`/environments/${namespace}/${loadtest.targetEnvironment}`} className="text-xs font-mono text-dfaas-400 hover:text-dfaas-300">
                env: {loadtest.targetEnvironment}
              </Link>
              <span title={pendingTooltip}>
                <PhaseBadge kind="loadtest" phase={loadtest.phase} size="lg" />
              </span>
              {isDraft && (
                <span className="badge text-xs px-3 py-1 bg-violet-500/15 text-violet-300 border border-violet-500/30 inline-flex items-center gap-1.5" id="loadtest-draft-badge">
                  <FileEdit className="w-3.5 h-3.5" />
                  Draft
                </span>
              )}
              {abortRequested && loadtest.phase !== 'Aborted' && (
                <span
                  className="badge text-xs px-3 py-1 bg-slate-500/15 text-slate-300 border border-slate-500/40 inline-flex items-center gap-1.5"
                  title="Abort requested. Operator is tearing down remote k6 jobs."
                  id="loadtest-aborting-badge"
                >
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Aborting…
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {isDraft && !isTerminal && (
              <button onClick={handleActivate} disabled={activating || aborting} className="btn-primary" id="start-loadtest-btn">
                <Play className="w-4 h-4" />
                {activating ? 'Starting...' : 'Start'}
              </button>
            )}
            {canAbort && (
              <button
                onClick={handleAbort}
                disabled={aborting}
                className="btn-secondary text-slate-300 hover:text-white border-slate-500/40"
                id="abort-loadtest-btn"
                title="Stop this load test. Operator reclaims remote k6 jobs; CR persists in history."
              >
                <Ban className="w-4 h-4" />
                {aborting ? 'Aborting…' : 'Abort Test'}
              </button>
            )}
            <button onClick={handleDownloadYAML} className="btn-secondary" id="download-loadtest-yaml-btn">
              <Download className="w-4 h-4" />
              Download YAML
            </button>
            <button
              onClick={handleDelete}
              disabled={deleting || isRunning}
              className="btn-secondary text-red-400 hover:text-red-300 disabled:opacity-40 disabled:hover:text-red-400"
              title="Delete will abort and clean up remote runs automatically."
            >
              <Trash2 className="w-4 h-4" />
              {deleting ? 'Deleting...' : 'Delete'}
            </button>
          </div>
        </div>
        {loadtest.message && (
          <div className={`mt-4 p-3 rounded-xl flex items-start gap-2 text-sm ${loadtest.phase === 'Failed' ? 'bg-red-500/10 border border-red-500/30 text-red-400' : 'bg-surface-800/50 border border-surface-700/50 text-surface-300'}`}>
            <Info className="w-4 h-4 mt-0.5 flex-shrink-0" />{loadtest.message}
          </div>
        )}
      </div>

      <div className={`grid gap-4 ${loadtest.startAt ? 'grid-cols-4' : 'grid-cols-3'}`}>
        <div className="glass-card p-4">
          <p className="text-xs text-surface-500 uppercase tracking-wider">Started</p>
          <p className="text-sm text-white mt-1">{loadtest.startTime ? formatDateTime(loadtest.startTime) : '—'}</p>
        </div>
        <div className="glass-card p-4">
          <p className="text-xs text-surface-500 uppercase tracking-wider">Ended</p>
          <p className="text-sm text-white mt-1">{loadtest.endTime ? formatDateTime(loadtest.endTime) : '—'}</p>
        </div>
        <div className="glass-card p-4">
          <p className="text-xs text-surface-500 uppercase tracking-wider">Exporter Job</p>
          <p className="text-sm font-mono text-white mt-1 truncate">{loadtest.exporterJob || '—'}</p>
        </div>
        {loadtest.startAt && <ScheduledStartCard startAt={loadtest.startAt} nowMs={nowMs} />}
      </div>

      {loadtest.phase === 'Pending' && (() => {
        const c = (loadtest.conditions || []).find(
          (x) => x.type === 'Ready' && ['Scheduled', 'ScheduledDelayedEnvNotReady', 'ScheduledFired'].includes(x.reason)
        );
        if (!c) return null;
        const tone = c.reason === 'ScheduledDelayedEnvNotReady'
          ? 'bg-amber-500/10 border-amber-500/30 text-amber-300'
          : c.reason === 'ScheduledFired'
            ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
            : 'bg-violet-500/10 border-violet-500/30 text-violet-300';
        return (
          <div className={`p-3 rounded-xl border text-sm flex items-start gap-2 ${tone}`}>
            <Info className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <span><strong>{c.reason}</strong> — {c.message}</span>
          </div>
        );
      })()}

      <ConditionsList conditions={loadtest.conditions} />

      <div className="glass-card p-5">
        <h2 className="text-lg font-semibold text-white flex items-center gap-2 mb-4">
          <Server className="w-5 h-5 text-amber-400" />Per-Node Test Runs ({loadtest.perNodeLoad?.length || 0})
        </h2>
        {(!loadtest.perNodeLoad || loadtest.perNodeLoad.length === 0) ? (
          <p className="text-sm text-surface-500">No per-node loads.</p>
        ) : (
          <div className="space-y-3">
            {loadtest.perNodeLoad.map((pn, i) => {
              const tr = (loadtest.testRuns || []).find(t => t.nodeID === pn.nodeID);
              const scriptOpen = expandedScript === pn.nodeID;
              return (
                <div key={pn.nodeID} className="border border-surface-700/50 rounded-xl bg-surface-900/30 overflow-hidden">
                  <div className="p-3 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <Server className="w-4 h-4 text-amber-400" />
                      <div>
                        <p className="text-sm font-semibold text-white">{pn.nodeID}</p>
                        <p className="text-[12px] text-surface-500 font-mono">vus={pn.vus} · duration={pn.duration}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 text-xs">
                      <TestRunBadge phase={tr?.phase} />
                      <span className="text-surface-500 font-mono">{tr?.name || pn.scriptConfigMap}</span>
                      <button
                        type="button"
                        onClick={() => downloadTextAsFile(pn.script || '', `${loadtest.name}-${pn.nodeID}.js`, 'text/javascript')}
                        disabled={!pn.script}
                        className="text-surface-400 hover:text-white disabled:opacity-30 disabled:hover:text-surface-400"
                        title={pn.script ? 'Download k6 script' : 'Script not available'}
                      >
                        <Download className="w-4 h-4" />
                      </button>
                      <button type="button" onClick={() => setExpandedScript(scriptOpen ? null : pn.nodeID)} className="text-surface-400 hover:text-white" title="Toggle script">
                        <FileCode className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                  {scriptOpen && (
                    <div className="border-t border-surface-700/50">
                      <pre className="code-block max-h-72 overflow-y-auto m-0 rounded-none border-0 text-[13px]">{pn.script || '(script not available)'}</pre>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="glass-card p-5">
        <h2 className="text-lg font-semibold text-white flex items-center gap-2 mb-3">
          <BarChart3 className="w-5 h-5 text-violet-400" />Metrics Export
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3 text-xs">
          <div className="md:col-span-3">
            <p className="text-surface-500 uppercase tracking-wider mb-1">Metrics</p>
            {(() => {
              const metrics = loadtest.metricsExport?.metrics;
              const legacyQueries = loadtest.metricsExport?.queries;
              if ((!metrics || metrics.length === 0) && Array.isArray(legacyQueries) && legacyQueries.length > 0) {
                return (
                  <div>
                    <div className="p-2 mb-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-300 text-[12px]">
                      Legacy format — recreate to migrate to the structured 4-field schema.
                    </div>
                    <ul className="space-y-1">
                      {legacyQueries.map((q, i) => (
                        <li key={i} className="font-mono text-surface-400 bg-surface-900/50 border border-surface-700/30 rounded-lg px-2 py-1 opacity-70">{q}</li>
                      ))}
                    </ul>
                  </div>
                );
              }
              if (!metrics || metrics.length === 0) {
                return <p className="text-surface-500 italic">No metrics configured.</p>;
              }
              return (
                <div className="overflow-x-auto">
                  <table className="w-full text-[13px]">
                    <thead>
                      <tr className="text-left text-[12px] text-surface-500 uppercase tracking-wider border-b border-surface-700/40">
                        <th className="py-1.5 px-2">Type</th>
                        <th className="py-1.5 px-2">Metric name</th>
                        <th className="py-1.5 px-2">PromQL query</th>
                        <th className="py-1.5 px-2">Comment</th>
                      </tr>
                    </thead>
                    <tbody>
                      {metrics.map((m, i) => (
                        <tr key={i} className="border-b border-surface-800/40">
                          <td className="py-1.5 px-2 text-surface-300">{m.type}</td>
                          <td className="py-1.5 px-2 font-mono text-surface-200">{m.metricName || <span className="text-surface-500 italic">(=query)</span>}</td>
                          <td className="py-1.5 px-2 font-mono text-surface-300 break-all">{m.query}</td>
                          <td className="py-1.5 px-2 text-surface-400">{m.comment || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              );
            })()}
          </div>
          <div>
            <p className="text-surface-500 uppercase tracking-wider mb-1">Step</p>
            <p className="font-mono text-surface-200">{loadtest.metricsExport?.step || '15s'}</p>
            <p className="text-surface-500 uppercase tracking-wider mt-3 mb-1">Destination</p>
            {environment?.s3ConfigRef ? (
              <p className="text-xs text-surface-300">
                S3 config{' '}
                <Link to={`/s3-configs/${environment.s3ConfigRef.name}`} className="font-mono text-dfaas-400 hover:text-dfaas-300 hover:underline">
                  {environment.s3ConfigRef.name}
                </Link>
                <span className="text-surface-500"> (inherited from environment)</span>
              </p>
            ) : (
              <p className="text-xs text-surface-500">
                No S3 config on environment → in-cluster SeaweedFS (default).
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
