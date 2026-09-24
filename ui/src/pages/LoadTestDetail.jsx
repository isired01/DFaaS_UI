import { useState, useEffect } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, TestTube2, Trash2, Server, BarChart3, FileCode, Download, Play, FileEdit, Ban, Loader2 } from 'lucide-react';
import { fetchLoadTest, deleteLoadTest, fetchLoadTestYAML, downloadTextAsFile, activateLoadTest, abortLoadTest, fetchEnvironment } from '../api/client';
import PhaseBadge from '../components/PhaseBadge';
import GeneratorProgress from '../components/GeneratorProgress';
import ScheduledStartCard from '../components/ScheduledStartCard';
import ConditionBanner from '../components/ConditionBanner';
import ConditionsList from '../components/ConditionsList';
import LoadingSpinner from '../components/LoadingSpinner';
import PageError from '../components/PageError';
import { lt as ltState, testRun, conditionOf, SCHEDULED_REASONS } from '../lib/crstate';
import { formatDateTime } from '../lib/format';
import { useResource } from '../lib/useResource';

export default function LoadTestDetail() {
  const { namespace, name } = useParams();
  const navigate = useNavigate();
  const [deleting, setDeleting] = useState(false);
  const [expandedScript, setExpandedScript] = useState(null);
  const [activating, setActivating] = useState(false);
  const [aborting, setAborting] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const {
    data: loadtest, setData: setLoadtest, loading, error, setError,
  } = useResource(
    ({ signal }) => fetchLoadTest(namespace, name, { signal }),
    {
      pollMs: 5000,
      // Stop polling a LoadTest that will not change any more. The predicate
      // reads the newest data from inside the hook, so the Phase is not an
      // effect dependency here.
      shouldPoll: ltState.changing,
      deps: [namespace, name],
    },
  );

  // The Environment is a hint on this page (its S3 config), never fatal, and
  // deliberately not part of the read above: awaiting it would hold the whole
  // page on the spinner.
  const { data: environment } = useResource(
    ({ signal }) => (loadtest?.targetEnvironment
      ? fetchEnvironment(namespace, loadtest.targetEnvironment, { signal })
      : Promise.resolve(null)),
    { deps: [namespace, loadtest?.targetEnvironment] },
  );

  // 1 Hz ticker: drives the scheduled-start countdown and the per-generator
  // progress bars. Gated so a finished test does not re-render once a second
  // forever.
  const ticking = !!loadtest?.startAt || loadtest?.phase === 'Running' || loadtest?.phase === 'Pending';
  useEffect(() => {
    if (!ticking) return undefined;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [ticking]);

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

  if (error) return <PageError message={error} back={{ to: '/loadtests', label: 'Back to Load Tests' }} />;

  if (!loadtest) return null;

  // Desired state from spec.suspended is the source of truth: the operator
  // stamps no Suspended condition.
  const isDraft = loadtest.suspended === true;
  const isTerminal = ltState.terminal(loadtest.phase);
  const abortRequested = loadtest.stop === true;
  const canAbort = ltState.abortable(loadtest.phase) && !abortRequested;
  // Tooltip on terminal Aborted: surface operator-stamped Ready=False reason=UserAborted message.
  const abortedMsg = loadtest.phase === 'Aborted'
    ? conditionOf(loadtest.conditions, 'Ready', ['UserAborted'])?.message || ''
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
              {loadtest.syncStart && (
                <span
                  className="badge text-xs px-3 py-1 bg-sky-500/15 text-sky-300 border border-sky-500/30 inline-flex items-center gap-1.5"
                  title="All generators wait for the operator's GO signal and start load together."
                >
                  Synchronized start
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
              disabled={deleting || !ltState.deletable(loadtest.phase)}
              className="btn-secondary text-red-400 hover:text-red-300 disabled:opacity-40 disabled:hover:text-red-400"
              title={ltState.deletable(loadtest.phase)
                ? 'Delete aborts the test and deletes its runners on every generator it can still reach.'
                : 'Abort a running test first; an exporting test becomes deletable once its export ends. Deleting it now would throw away the run or its metrics export.'}
            >
              <Trash2 className="w-4 h-4" />
              {deleting ? 'Deleting...' : 'Delete'}
            </button>
          </div>
        </div>
      </div>

      <div className={`grid gap-4 ${loadtest.startAt ? 'grid-cols-4' : 'grid-cols-3'}`}>
        <div className="glass-card p-4">
          <p className="text-xs text-surface-450 uppercase tracking-wider">Started</p>
          <p className="text-sm text-white mt-1">{loadtest.startTime ? formatDateTime(loadtest.startTime) : '—'}</p>
        </div>
        <div className="glass-card p-4">
          <p className="text-xs text-surface-450 uppercase tracking-wider">Ended</p>
          <p className="text-sm text-white mt-1">{loadtest.endTime ? formatDateTime(loadtest.endTime) : '—'}</p>
        </div>
        <div className="glass-card p-4">
          <p className="text-xs text-surface-450 uppercase tracking-wider">Exporter Job</p>
          <p className="text-sm font-mono text-white mt-1 truncate">{loadtest.exporterJob || '—'}</p>
        </div>
        {loadtest.startAt && <ScheduledStartCard startAt={loadtest.startAt} nowMs={nowMs} />}
      </div>

      {loadtest.phase === 'Pending' && loadtest.startAt && (
        <ConditionBanner
          condition={conditionOf(loadtest.conditions, 'Scheduled', SCHEDULED_REASONS)}
        />
      )}

      {loadtest.results && (
        <div className="glass-card p-5">
          <h2 className="text-lg font-semibold text-white flex items-center gap-2 mb-3">
            <BarChart3 className="w-5 h-5 text-emerald-400" />Results on SeaweedFS
          </h2>
          <p className="text-xs text-surface-450 mb-3">
            Exported artifacts, browsable in the SeaweedFS filer (no login).
          </p>
          <div className="flex flex-col gap-2 text-sm">
            <a href={loadtest.results.metricsUrl} target="_blank" rel="noopener noreferrer"
               className="text-emerald-300 hover:text-emerald-200 underline underline-offset-2 break-all">
              Metrics CSV — {loadtest.results.metricsUrl}
            </a>
            <a href={loadtest.results.k6Url} target="_blank" rel="noopener noreferrer"
               className="text-emerald-300 hover:text-emerald-200 underline underline-offset-2 break-all">
              k6 logs &amp; summaries — {loadtest.results.k6Url}
            </a>
          </div>
        </div>
      )}

      <ConditionsList conditions={loadtest.conditions} />

      <div className="glass-card p-5">
        <h2 className="text-lg font-semibold text-white flex items-center gap-2 mb-4">
          <Server className="w-5 h-5 text-amber-400" />Per-Node Test Runs ({loadtest.perNodeLoad?.length || 0})
        </h2>
        {(!loadtest.perNodeLoad || loadtest.perNodeLoad.length === 0) ? (
          <p className="text-sm text-surface-450">No per-node loads.</p>
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
                        <p className="text-[12px] text-surface-450 font-mono">vus={pn.vus} · duration={pn.duration}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 text-xs">
                      <span className={`badge text-[12px] px-2 py-0.5 border ${testRun.style(tr?.phase)}`}>{tr?.phase || '—'}</span>
                      <span className="text-surface-450 font-mono">{tr?.name || pn.scriptConfigMap}</span>
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
                  <div className="px-3 pb-3">
                    <GeneratorProgress
                      stage={tr?.phase}
                      phase={loadtest.phase}
                      startTime={loadtest.startTime}
                      duration={pn.duration}
                      nowMs={nowMs}
                    />
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
            <p className="text-surface-450 uppercase tracking-wider mb-1">Metrics</p>
            {(() => {
              const metrics = loadtest.metricsExport?.metrics;
              if (!metrics || metrics.length === 0) {
                return <p className="text-surface-450 italic">No metrics configured.</p>;
              }
              return (
                <div className="overflow-x-auto">
                  <table className="w-full text-[13px]">
                    <thead>
                      <tr className="text-left text-[12px] text-surface-450 uppercase tracking-wider border-b border-surface-700/40">
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
                          <td className="py-1.5 px-2 font-mono text-surface-200">{m.metricName || <span className="text-surface-450 italic">(=query)</span>}</td>
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
            <p className="text-surface-450 uppercase tracking-wider mb-1">Step</p>
            <p className="font-mono text-surface-200">{loadtest.metricsExport?.step || '15s'}</p>
            <p className="text-surface-450 uppercase tracking-wider mt-3 mb-1">Destination</p>
            {environment?.s3ConfigRef ? (
              <p className="text-xs text-surface-300">
                S3 config{' '}
                <Link to={`/s3-configs/${environment.s3ConfigRef.name}`} className="font-mono text-dfaas-400 hover:text-dfaas-300 hover:underline">
                  {environment.s3ConfigRef.name}
                </Link>
                <span className="text-surface-450"> (inherited from environment)</span>
              </p>
            ) : (
              <p className="text-xs text-surface-450">
                No S3 config on environment → in-cluster SeaweedFS (default).
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
