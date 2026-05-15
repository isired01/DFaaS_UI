import { useState, useEffect } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, TestTube2, Trash2, AlertTriangle, Info, ChevronDown, ChevronUp, Server, BarChart3, FileCode } from 'lucide-react';
import { fetchLoadTest, deleteLoadTest } from '../api/client';
import PhaseBadge from '../components/PhaseBadge';

const ACTIVE_PHASES = new Set(['Pending', 'Running', 'Exporting', '']);

const TR_PHASE_STYLE = {
  created:  'bg-surface-700/40 text-surface-300 border-surface-600/40',
  started:  'bg-amber-500/15 text-amber-400 border-amber-500/30',
  finished: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  stopped:  'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  error:    'bg-red-500/15 text-red-400 border-red-500/30',
};

function TestRunBadge({ phase }) {
  const cls = TR_PHASE_STYLE[phase] || TR_PHASE_STYLE.created;
  return <span className={`badge text-[10px] px-2 py-0.5 border ${cls}`}>{phase || '—'}</span>;
}

export default function LoadTestDetail() {
  const { namespace, name } = useParams();
  const navigate = useNavigate();
  const [loadtest, setLoadtest] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [expandedScript, setExpandedScript] = useState(null);
  const [showSpec, setShowSpec] = useState(false);

  useEffect(() => {
    const load = async () => {
      try {
        setError(null);
        const data = await fetchLoadTest(namespace, name);
        setLoadtest(data);
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

  const handleDelete = async () => {
    if (!confirm(`Delete load test '${name}'?`)) return;
    setDeleting(true);
    try {
      await deleteLoadTest(namespace, name);
      navigate(`/environments/${namespace}/${loadtest.targetEnvironment}`);
    } catch (err) {
      setError(err.message);
      setDeleting(false);
    }
  };

  if (loading) return (
    <div className="flex items-center justify-center py-32">
      <div className="w-10 h-10 border-3 border-dfaas-500/30 border-t-dfaas-500 rounded-full animate-spin" />
    </div>
  );

  if (error) return (
    <div className="glass-card p-8 text-center border-red-500/30 bg-red-500/5">
      <AlertTriangle className="w-10 h-10 text-red-400 mx-auto mb-3" />
      <p className="text-red-400">{error}</p>
      <Link to="/loadtests" className="btn-secondary mt-4 inline-flex">← Back to Load Tests</Link>
    </div>
  );

  if (!loadtest) return null;

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
              <PhaseBadge kind="loadtest" phase={loadtest.phase} size="lg" />
            </div>
          </div>
          <button onClick={handleDelete} disabled={deleting} className="btn-secondary text-red-400 hover:text-red-300">
            <Trash2 className="w-4 h-4" />
            {deleting ? 'Deleting...' : 'Delete'}
          </button>
        </div>
        {loadtest.message && (
          <div className={`mt-4 p-3 rounded-xl flex items-start gap-2 text-sm ${loadtest.phase === 'Failed' ? 'bg-red-500/10 border border-red-500/30 text-red-400' : 'bg-surface-800/50 border border-surface-700/50 text-surface-300'}`}>
            <Info className="w-4 h-4 mt-0.5 flex-shrink-0" />{loadtest.message}
          </div>
        )}
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div className="glass-card p-4">
          <p className="text-xs text-surface-500 uppercase tracking-wider">Started</p>
          <p className="text-sm text-white mt-1">{loadtest.startTime ? new Date(loadtest.startTime).toLocaleString('en-GB') : '—'}</p>
        </div>
        <div className="glass-card p-4">
          <p className="text-xs text-surface-500 uppercase tracking-wider">Ended</p>
          <p className="text-sm text-white mt-1">{loadtest.endTime ? new Date(loadtest.endTime).toLocaleString('en-GB') : '—'}</p>
        </div>
        <div className="glass-card p-4">
          <p className="text-xs text-surface-500 uppercase tracking-wider">Exporter Job</p>
          <p className="text-sm font-mono text-white mt-1 truncate">{loadtest.exporterJob || '—'}</p>
        </div>
      </div>

      {loadtest.conditions && loadtest.conditions.length > 0 && (
        <div className="glass-card p-5">
          <h2 className="text-sm font-semibold text-surface-300 uppercase tracking-wider mb-3">Conditions</h2>
          <div className="space-y-2">
            {loadtest.conditions.map((c, i) => (
              <div key={i} className="flex items-center justify-between p-3 rounded-xl bg-surface-900/50 border border-surface-700/30">
                <div className="flex items-center gap-3">
                  <div className={`w-2 h-2 rounded-full ${c.status === 'True' ? 'bg-emerald-400' : 'bg-amber-400'}`} />
                  <span className="text-sm font-medium text-white">{c.type}</span>
                  <span className="text-xs text-surface-500">{c.reason}</span>
                </div>
                <span className="text-xs text-surface-400">{c.message}</span>
              </div>
            ))}
          </div>
        </div>
      )}

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
                        <p className="text-[10px] text-surface-500 font-mono">vus={pn.vus} · duration={pn.duration}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 text-xs">
                      <TestRunBadge phase={tr?.phase} />
                      <span className="text-surface-500 font-mono">{tr?.name || pn.scriptConfigMap}</span>
                      <button type="button" onClick={() => setExpandedScript(scriptOpen ? null : pn.nodeID)} className="text-surface-400 hover:text-white" title="Toggle script">
                        <FileCode className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                  {scriptOpen && (
                    <div className="border-t border-surface-700/50">
                      <pre className="code-block max-h-72 overflow-y-auto m-0 rounded-none border-0 text-[11px]">{pn.script || '(script not available)'}</pre>
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
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
          <div className="md:col-span-2">
            <p className="text-surface-500 uppercase tracking-wider mb-1">Queries</p>
            <ul className="space-y-1">
              {(loadtest.metricsExport?.queries || []).map((q, i) => (
                <li key={i} className="font-mono text-surface-200 bg-surface-900/50 border border-surface-700/30 rounded-lg px-2 py-1">{q}</li>
              ))}
            </ul>
          </div>
          <div>
            <p className="text-surface-500 uppercase tracking-wider mb-1">Step</p>
            <p className="font-mono text-surface-200">{loadtest.metricsExport?.step || '15s'}</p>
            {loadtest.metricsExport?.googleDrive && (
              <>
                <p className="text-surface-500 uppercase tracking-wider mt-3 mb-1">Google Drive</p>
                <pre className="code-block text-[10px] max-h-32 overflow-y-auto">{JSON.stringify(loadtest.metricsExport.googleDrive, null, 2)}</pre>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="glass-card p-5">
        <button type="button" onClick={() => setShowSpec(!showSpec)} className="flex items-center justify-between w-full text-left">
          <span className="text-sm font-semibold text-surface-300 uppercase tracking-wider">Raw Spec</span>
          {showSpec ? <ChevronUp className="w-4 h-4 text-surface-400" /> : <ChevronDown className="w-4 h-4 text-surface-400" />}
        </button>
        {showSpec && (
          <pre className="code-block mt-3 max-h-96 overflow-y-auto text-[11px]">{JSON.stringify({
            perNodeLoad: loadtest.perNodeLoad?.map(p => ({ nodeID: p.nodeID, vus: p.vus, duration: p.duration, scriptConfigMap: p.scriptConfigMap })),
            metricsExport: loadtest.metricsExport,
            testRuns: loadtest.testRuns,
          }, null, 2)}</pre>
        )}
      </div>
    </div>
  );
}
