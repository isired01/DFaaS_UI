import { useState, useEffect } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Network, Zap, TestTube2, AlertTriangle, Info, Plus, Trash2, Server, Cpu, Download, Pencil, RefreshCw, Database } from 'lucide-react';
import { fetchEnvironment, fetchLoadTests, deleteEnvironment, fetchEnvironmentYAML, downloadTextAsFile } from '../api/client';
import PhaseBadge from '../components/PhaseBadge';
import NodeCard from '../components/NodeCard';
import ConditionsList from '../components/ConditionsList';
import ProvisioningConditionRow from '../components/ProvisioningConditionRow';

export default function EnvironmentDetail() {
  const { namespace, name } = useParams();
  const navigate = useNavigate();
  const [environment, setEnvironment] = useState(null);
  const [loadtests, setLoadtests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    const load = async () => {
      try {
        setError(null);
        const [env, lts] = await Promise.all([
          fetchEnvironment(namespace, name),
          fetchLoadTests({ environment: `${namespace}/${name}` }).catch(() => []),
        ]);
        setEnvironment(env);
        setLoadtests(lts);
      } catch (err) { setError(err.message); }
      finally { setLoading(false); }
    };
    load();
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, [namespace, name]);

  const handleDownloadYAML = async () => {
    try {
      const yaml = await fetchEnvironmentYAML(namespace, name);
      downloadTextAsFile(yaml, `environment-${namespace}-${name}.yaml`, 'application/yaml');
    } catch (err) { setError(err.message); }
  };

  const handleDelete = async () => {
    if (!confirm(`Delete environment '${name}'? The operator finalizer will tear down VMs if cleanupOnDelete is true.`)) return;
    setDeleting(true);
    try {
      await deleteEnvironment(namespace, name);
      navigate('/');
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
      <Link to="/" className="btn-secondary mt-4 inline-flex">← Back to Environments</Link>
    </div>
  );

  if (!environment) return null;

  const isReady = environment.phase === 'Ready';
  const dfaasNodes = (environment.nodes || []).filter(n => n.role === 'dfaas-worker');
  const k6StatusByID = Object.fromEntries((environment.k6Nodes || []).map(k => [k.nodeID, k]));
  const k6Nodes = (environment.nodes || [])
    .filter(n => n.role === 'k6-load-generator')
    .map(n => ({ ...n, kubeconfigSecret: k6StatusByID[n.nodeID]?.kubeconfigSecret || '' }));

  const gen = environment.generation ?? 0;
  const observedGen = environment.observedGeneration ?? 0;
  const isUpdating = observedGen > 0 && gen > observedGen;

  return (
    <div className="space-y-8 animate-fade-in">
      <div>
        <Link to="/" className="inline-flex items-center gap-1.5 text-sm text-surface-400 hover:text-white transition-colors mb-4">
          <ArrowLeft className="w-4 h-4" />Back to Environments
        </Link>
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold text-white" id="environment-name">{environment.name}</h1>
            <div className="flex items-center gap-3 mt-2 flex-wrap">
              <span className="text-xs font-mono text-surface-400 px-2 py-1 bg-surface-800/50 rounded-lg border border-surface-700/50">{environment.namespace}</span>
              <PhaseBadge kind="env" phase={environment.phase} size="lg" />
              {isUpdating && (
                <span
                  className="badge text-xs px-3 py-1 bg-amber-500/15 text-amber-300 border border-amber-500/40 inline-flex items-center gap-1.5"
                  title={`Spec edited (gen ${observedGen} → ${gen}). Operator is restarting from ProvisioningVMs.`}
                  id="environment-updating-badge"
                >
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  Updating (gen {observedGen} → {gen})
                </span>
              )}
              {environment.cleanupOnDelete && (
                <span className="text-[10px] text-orange-400 uppercase tracking-wider">cleanup on delete</span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Link
              to={`/environments/${environment.namespace}/${environment.name}/edit`}
              className={`btn-secondary ${isUpdating ? 'opacity-50 pointer-events-none' : ''}`}
              title={isUpdating ? 'Update in progress — wait for reconcile to settle' : 'Edit spec (PATCH)'}
              id="edit-environment-btn"
            >
              <Pencil className="w-4 h-4" />
              Edit
            </Link>
            <button onClick={handleDownloadYAML} className="btn-secondary" id="download-environment-yaml-btn">
              <Download className="w-4 h-4" />
              Download YAML
            </button>
            <button onClick={handleDelete} disabled={deleting || isUpdating} className="btn-secondary text-red-400 hover:text-red-300" id="delete-environment-btn" title={isUpdating ? 'Cannot delete while update in progress' : ''}>
              <Trash2 className="w-4 h-4" />
              {deleting ? 'Deleting...' : 'Delete'}
            </button>
          </div>
        </div>
        {environment.message && (
          <div className={`mt-4 p-3 rounded-xl flex items-start gap-2 text-sm ${environment.phase === 'Failed' ? 'bg-red-500/10 border border-red-500/30 text-red-400' : 'bg-surface-800/50 border border-surface-700/50 text-surface-300'}`}>
            <Info className="w-4 h-4 mt-0.5 flex-shrink-0" />{environment.message}
          </div>
        )}
      </div>

      {environment.phase === 'ProvisioningInfra' && (
        <div className="glass-card p-5" id="provisioning-infra-progress">
          <h2 className="text-sm font-semibold text-surface-300 uppercase tracking-wider mb-3">Infrastructure Provisioning (parallel)</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <ProvisioningConditionRow conditions={environment.conditions} type="DFaaSNodesReady" label="DFaaS Nodes (Ansible)" />
            <ProvisioningConditionRow conditions={environment.conditions} type="K6Ready" label="k6 Generators (Ansible)" />
          </div>
        </div>
      )}

      {environment.phase === 'ProvisioningMonitoring' && (
        <div className="glass-card p-5" id="provisioning-monitoring-progress">
          <h2 className="text-sm font-semibold text-surface-300 uppercase tracking-wider mb-3">Monitoring Stack</h2>
          <div className="grid grid-cols-1 gap-3">
            <ProvisioningConditionRow conditions={environment.conditions} type="MonitoringReady" label="Prometheus + Grafana (Helm)" />
          </div>
        </div>
      )}

      <ConditionsList conditions={environment.conditions} />

      <div>
        <h2 className="text-lg font-semibold text-white flex items-center gap-2 mb-4" id="dfaas-nodes-section">
          <Cpu className="w-5 h-5 text-dfaas-400" />DFaaS Nodes
          <span className="text-sm font-normal text-surface-500">({dfaasNodes.length})</span>
        </h2>
        {dfaasNodes.length === 0 ? (
          <p className="text-sm text-surface-500 glass-card p-4">No DFaaS worker nodes in this environment.</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {dfaasNodes.map((node, i) => (
              <NodeCard key={node.nodeID} node={node} index={i} variant="dfaas" />
            ))}
          </div>
        )}
      </div>

      <div>
        <h2 className="text-lg font-semibold text-white flex items-center gap-2 mb-4" id="k6-nodes-section">
          <Server className="w-5 h-5 text-amber-400" />k6 Generators
          <span className="text-sm font-normal text-surface-500">({k6Nodes.length})</span>
        </h2>
        {k6Nodes.length === 0 ? (
          <p className="text-sm text-surface-500 glass-card p-4">No k6 generators in this environment.</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {k6Nodes.map((node, i) => (
              <NodeCard key={node.nodeID} node={node} index={i} variant="k6" />
            ))}
          </div>
        )}
      </div>

      {environment.s3ConfigRef && (
        <div className="glass-card p-5" id="s3-config-ref-block">
          <h2 className="text-sm font-semibold text-surface-300 uppercase tracking-wider mb-3 flex items-center gap-2">
            <Database className="w-4 h-4 text-dfaas-400" />Metrics S3 Config
          </h2>
          <div className="flex items-center gap-3">
            <Link
              to={`/s3-configs/${environment.s3ConfigRef.name}`}
              className="text-sm font-mono text-dfaas-400 hover:text-dfaas-300 hover:underline"
            >
              {environment.s3ConfigRef.name}
            </Link>
            <span className="text-xs text-surface-500">
              every LoadTest export lands in <code>s3://{environment.name}-&lt;uid&gt;/metrics/...</code>
            </span>
          </div>
        </div>
      )}

      {environment.topology?.links?.length > 0 && (
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
                {environment.topology.links.map((link, i) => (
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

      <div className="glass-card p-6" id="loadtests-section">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-white flex items-center gap-2">
            <TestTube2 className="w-5 h-5 text-amber-400" />Load Tests
            <span className="text-sm font-normal text-surface-500">({loadtests.length})</span>
          </h2>
          <Link
            to={`/environments/${namespace}/${name}/loadtests/new`}
            title={isReady ? '' : 'Environment not Ready — you can configure but cannot launch yet'}
            className="btn-primary text-xs px-4 py-2"
            id="new-loadtest-btn"
          >
            <Plus className="w-3.5 h-3.5" />
            New Load Test
          </Link>
        </div>

        {!isReady && (
          <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-center gap-3 mb-4">
            <AlertTriangle className="w-5 h-5 text-amber-400 flex-shrink-0" />
            <span className="text-sm text-amber-300">
              Load tests can be launched only when the environment is in phase <strong>Ready</strong>.
            </span>
          </div>
        )}

        {loadtests.length === 0 ? (
          <p className="text-sm text-surface-500 text-center py-8">No load tests for this environment yet.</p>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-surface-700/50">
                <th className="text-left py-2 px-4 text-xs font-semibold text-surface-400 uppercase">Name</th>
                <th className="text-left py-2 px-4 text-xs font-semibold text-surface-400 uppercase">Phase</th>
                <th className="text-left py-2 px-4 text-xs font-semibold text-surface-400 uppercase">Start</th>
                <th className="text-left py-2 px-4 text-xs font-semibold text-surface-400 uppercase">End</th>
                <th className="text-left py-2 px-4 text-xs font-semibold text-surface-400 uppercase">Created</th>
              </tr>
            </thead>
            <tbody>
              {loadtests.map((lt, i) => (
                <tr key={`${lt.namespace}/${lt.name}`} className="border-b border-surface-800/30 hover:bg-surface-800/30 transition-colors animate-slide-up" style={{ animationDelay: `${i * 40}ms` }}>
                  <td className="py-2.5 px-4">
                    <Link to={`/loadtests/${lt.namespace}/${lt.name}`} className="text-sm font-semibold text-white hover:text-dfaas-400 transition-colors">{lt.name}</Link>
                  </td>
                  <td className="py-2.5 px-4"><PhaseBadge kind="loadtest" phase={lt.phase} size="sm" /></td>
                  <td className="py-2.5 px-4 text-xs text-surface-400">{lt.startTime ? new Date(lt.startTime).toLocaleString('en-GB') : '—'}</td>
                  <td className="py-2.5 px-4 text-xs text-surface-400">{lt.endTime ? new Date(lt.endTime).toLocaleString('en-GB') : '—'}</td>
                  <td className="py-2.5 px-4 text-xs text-surface-400">{new Date(lt.creationTimestamp).toLocaleString('en-GB')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
