import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Network, Zap, TestTube2, FileUp, Wand2, AlertTriangle, Info } from 'lucide-react';
import { fetchExperiment } from '../api/client';
import PhaseBadge from '../components/PhaseBadge';
import NodeCard from '../components/NodeCard';
import K6ConfigForm from '../components/K6ConfigForm';
import K6FileUpload from '../components/K6FileUpload';

export default function ExperimentDetail() {
  const { namespace, name } = useParams();
  const [experiment, setExperiment] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [k6Tab, setK6Tab] = useState('generate'); // 'generate' | 'upload'
  const [uploadResult, setUploadResult] = useState(null);

  useEffect(() => {
    const load = async () => {
      try {
        setError(null);
        const data = await fetchExperiment(namespace, name);
        setExperiment(data);
      } catch (err) { setError(err.message); }
      finally { setLoading(false); }
    };
    load();
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, [namespace, name]);

  if (loading) return (
    <div className="flex items-center justify-center py-32">
      <div className="w-10 h-10 border-3 border-dfaas-500/30 border-t-dfaas-500 rounded-full animate-spin" />
    </div>
  );

  if (error) return (
    <div className="glass-card p-8 text-center border-red-500/30 bg-red-500/5">
      <AlertTriangle className="w-10 h-10 text-red-400 mx-auto mb-3" />
      <p className="text-red-400">{error}</p>
      <Link to="/" className="btn-secondary mt-4 inline-flex">← Torna alla Dashboard</Link>
    </div>
  );

  if (!experiment) return null;

  const isReady = experiment.phase === 'READY';

  return (
    <div className="space-y-8 animate-fade-in">
      {/* Back + Header */}
      <div>
        <Link to="/" className="inline-flex items-center gap-1.5 text-sm text-surface-400 hover:text-white transition-colors mb-4">
          <ArrowLeft className="w-4 h-4" />Torna alla Dashboard
        </Link>
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold text-white" id="experiment-name">{experiment.name}</h1>
            <div className="flex items-center gap-3 mt-2">
              <span className="text-xs font-mono text-surface-400 px-2 py-1 bg-surface-800/50 rounded-lg border border-surface-700/50">{experiment.namespace}</span>
              <PhaseBadge phase={experiment.phase} size="lg" />
            </div>
          </div>
        </div>
        {experiment.message && (
          <div className={`mt-4 p-3 rounded-xl flex items-start gap-2 text-sm ${experiment.phase === 'FAILED' ? 'bg-red-500/10 border border-red-500/30 text-red-400' : 'bg-surface-800/50 border border-surface-700/50 text-surface-300'}`}>
            <Info className="w-4 h-4 mt-0.5 flex-shrink-0" />{experiment.message}
          </div>
        )}
      </div>

      {/* Conditions */}
      {experiment.conditions && experiment.conditions.length > 0 && (
        <div className="glass-card p-5">
          <h2 className="text-sm font-semibold text-surface-300 uppercase tracking-wider mb-3">Conditions</h2>
          <div className="space-y-2">
            {experiment.conditions.map((c, i) => (
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

      {/* Federation Nodes */}
      <div>
        <h2 className="text-lg font-semibold text-white flex items-center gap-2 mb-4" id="federation-section">
          <Network className="w-5 h-5 text-dfaas-400" />Federation Nodes
          <span className="text-sm font-normal text-surface-500">({experiment.federation?.nodes?.length || 0} nodi)</span>
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {experiment.federation?.nodes?.map((node, i) => (
            <NodeCard key={node.nodeID} node={node} index={i} />
          ))}
        </div>
      </div>

      {/* Topology */}
      {experiment.topology?.links?.length > 0 && (
        <div className="glass-card p-5">
          <h2 className="text-lg font-semibold text-white flex items-center gap-2 mb-4" id="topology-section">
            <Zap className="w-5 h-5 text-violet-400" />Network Topology
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-surface-700/50">
                  <th className="text-left py-2 px-4 text-xs font-semibold text-surface-400 uppercase">Node A</th>
                  <th className="text-left py-2 px-4 text-xs font-semibold text-surface-400 uppercase">Node B</th>
                  <th className="text-left py-2 px-4 text-xs font-semibold text-surface-400 uppercase">Latency</th>
                </tr>
              </thead>
              <tbody>
                {experiment.topology.links.map((link, i) => (
                  <tr key={i} className="border-b border-surface-800/30">
                    <td className="py-2.5 px-4 text-sm font-mono text-surface-200">{link.nodeA}</td>
                    <td className="py-2.5 px-4 text-sm font-mono text-surface-200">{link.nodeB}</td>
                    <td className="py-2.5 px-4">
                      <span className={`text-sm font-semibold ${link.latencyMs < 30 ? 'text-emerald-400' : link.latencyMs < 60 ? 'text-amber-400' : 'text-red-400'}`}>
                        {link.latencyMs}ms
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* K6 Load Test Section */}
      <div className="glass-card p-6" id="k6-section">
        <h2 className="text-lg font-semibold text-white flex items-center gap-2 mb-2">
          <TestTube2 className="w-5 h-5 text-amber-400" />Load Test Configuration
        </h2>
        <p className="text-sm text-surface-400 mb-5">
          {isReady
            ? 'L\'esperimento è pronto. Configura e genera lo script k6 per il load test.'
            : `L'esperimento è in fase "${experiment.phase}". Il load test sarà disponibile quando lo stato sarà READY.`}
        </p>

        {!isReady && (
          <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-center gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-400 flex-shrink-0" />
            <span className="text-sm text-amber-300">
              Il k6 load test può essere avviato solo quando l'esperimento è in fase <strong>READY</strong>.
            </span>
          </div>
        )}

        {/* Tabs */}
        <div className="flex gap-1 p-1 bg-surface-900/50 rounded-xl mb-6 w-fit">
          <button onClick={() => setK6Tab('generate')} className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${k6Tab === 'generate' ? 'bg-dfaas-600/30 text-dfaas-400 border border-dfaas-500/30' : 'text-surface-400 hover:text-white'}`} id="tab-generate">
            <Wand2 className="w-4 h-4" />Generate Script
          </button>
          <button onClick={() => setK6Tab('upload')} className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${k6Tab === 'upload' ? 'bg-dfaas-600/30 text-dfaas-400 border border-dfaas-500/30' : 'text-surface-400 hover:text-white'}`} id="tab-upload">
            <FileUp className="w-4 h-4" />Upload Script
          </button>
        </div>

        {k6Tab === 'generate' ? (
          <K6ConfigForm experiment={experiment} isReady={isReady} />
        ) : (
          <div className="space-y-4">
            <K6FileUpload onResult={setUploadResult} isReady={isReady} />
            {uploadResult && (
              <div className="animate-slide-up">
                <h4 className="text-sm font-semibold text-surface-300 mb-2">Generated YAML</h4>
                <pre className="code-block max-h-80 overflow-y-auto">{uploadResult.yaml}</pre>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
