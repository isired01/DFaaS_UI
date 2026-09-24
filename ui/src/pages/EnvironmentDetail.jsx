import { useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Network, Zap, TestTube2, AlertTriangle, Plus, Trash2, Server, Cpu, Download, Pencil, RefreshCw, Database } from 'lucide-react';
import { fetchEnvironment, fetchLoadTests, deleteEnvironment, fetchEnvironmentYAML, downloadTextAsFile } from '../api/client';
import PhaseBadge from '../components/PhaseBadge';
import NodeCard from '../components/NodeCard';
import ConditionsList from '../components/ConditionsList';
import ProvisioningConditionRow from '../components/ProvisioningConditionRow';
import LoadingSpinner from '../components/LoadingSpinner';
import PageError from '../components/PageError';
import { formatDateTime } from '../lib/format';
import { env as envState, lt as ltState } from '../lib/crstate';
import { useResource } from '../lib/useResource';

export default function EnvironmentDetail() {
  const { namespace, name } = useParams();
  const navigate = useNavigate();
  const [deleting, setDeleting] = useState(false);

  // One read, one error, one spinner: the LoadTest list is a non-fatal extra on
  // the Environment read, exactly as before.
  const { data, loading, error, setError } = useResource(
    async ({ signal }) => {
      const [env, lts] = await Promise.all([
        fetchEnvironment(namespace, name, { signal }),
        fetchLoadTests({ environment: `${namespace}/${name}`, signal }).catch(() => []),
      ]);
      return { env, lts };
    },
    { pollMs: 5000, deps: [namespace, name] },
  );
  const environment = data?.env || null;
  const loadtests = data?.lts || [];

  const handleDownloadYAML = async () => {
    try {
      const yaml = await fetchEnvironmentYAML(namespace, name);
      downloadTextAsFile(yaml, `environment-${namespace}-${name}.yaml`, 'application/yaml');
    } catch (err) { setError(err.message); }
  };

  const handleDelete = async () => {
    if (!confirm(`Delete environment '${name}'? The VMs are left running — the finalizer only removes the operator's own resources.`)) return;
    setDeleting(true);
    try {
      await deleteEnvironment(namespace, name);
      navigate('/');
    } catch (err) {
      setError(err.message);
      setDeleting(false);
    }
  };

  if (loading) return <LoadingSpinner />;

  if (error) return <PageError message={error} back={{ to: '/', label: 'Back to Environments' }} />;

  if (!environment) return null;

  const isDispatchable = envState.dispatchable(environment.phase);
  const dfaasNodes = (environment.nodes || []).filter(n => n.role === 'dfaas-worker');
  const k6StatusByID = Object.fromEntries((environment.k6Nodes || []).map(k => [k.nodeID, k]));
  const k6Nodes = (environment.nodes || [])
    .filter(n => n.role === 'k6-load-generator')
    .map(n => ({ ...n, kubeconfigSecret: k6StatusByID[n.nodeID]?.kubeconfigSecret || '' }));

  const gen = environment.generation ?? 0;
  const observedGen = environment.observedGeneration ?? 0;
  const isUpdating = observedGen > 0 && gen > observedGen;

  // Mirrors activeLoadTestNames in the gateway: a node or topology edit re-runs
  // Ansible on every node, and a role change wipes the node outright, so the
  // gateway answers 409 while any test still owns its generators. Surfaced here
  // so the user sees why Edit is unavailable instead of meeting that 409 after
  // filling in the whole form. Suspended Pending tests are parked and excluded.
  const activeLoadtests = (loadtests || []).filter(ltState.occupying);
  const editBlockReason = isUpdating
    ? 'Update in progress — wait for reconcile to settle'
    : activeLoadtests.length > 0
      ? `Cannot edit nodes while a load test is active: ${activeLoadtests.map(lt => lt.runnersUnreclaimed
          ? `${lt.name} (${lt.phase}, runners not reclaimed: delete the test to release the Environment, up to 2 min)`
          : `${lt.name} (${lt.phase})`).join(', ')}. Abort it or wait for it to finish.`
      : '';

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
              {environment.lastHealthCheck && (
                <span className="text-[12px] text-surface-450" id="environment-last-health-check">
                  Last health check: {formatDateTime(environment.lastHealthCheck)}
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Link
              to={`/environments/${environment.namespace}/${environment.name}/edit`}
              className={`btn-secondary ${editBlockReason ? 'opacity-50 pointer-events-none' : ''}`}
              aria-disabled={editBlockReason ? 'true' : undefined}
              title={editBlockReason || 'Edit spec (PATCH)'}
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
          <span className="text-sm font-normal text-surface-450">({dfaasNodes.length})</span>
        </h2>
        {dfaasNodes.length === 0 ? (
          <p className="text-sm text-surface-450 glass-card p-4">No DFaaS worker nodes in this environment.</p>
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
          <span className="text-sm font-normal text-surface-450">({k6Nodes.length})</span>
        </h2>
        {k6Nodes.length === 0 ? (
          <p className="text-sm text-surface-450 glass-card p-4">No k6 generators in this environment.</p>
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
            <span className="text-xs text-surface-450">
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
          <div className="flex items-start gap-2 p-2.5 mb-4 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-300 text-[13px] leading-snug">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
            <span>
              <strong>Not supported yet — placeholder.</strong> These links are stored on the Environment, but nothing applies latency shaping between the nodes, so the values below have no effect on the running federation.
            </span>
          </div>
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
            <span className="text-sm font-normal text-surface-450">({loadtests.length})</span>
          </h2>
          <Link
            to={`/environments/${namespace}/${name}/loadtests/new`}
            title={isDispatchable ? '' : 'Environment not dispatchable yet — you can configure and save a draft, but not launch'}
            className="btn-primary text-xs px-4 py-2"
            id="new-loadtest-btn"
          >
            <Plus className="w-3.5 h-3.5" />
            New Load Test
          </Link>
        </div>

        {!isDispatchable && (
          <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-center gap-3 mb-4">
            <AlertTriangle className="w-5 h-5 text-amber-400 flex-shrink-0" />
            <span className="text-sm text-amber-300">
              Load tests can be launched only while the environment is <strong>Ready</strong>. You can still configure one and save it as a draft.
            </span>
          </div>
        )}

        {loadtests.length === 0 ? (
          <p className="text-sm text-surface-450 text-center py-8">No load tests for this environment yet.</p>
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
                  <td className="py-2.5 px-4 text-xs text-surface-400">{lt.startTime ? formatDateTime(lt.startTime) : '—'}</td>
                  <td className="py-2.5 px-4 text-xs text-surface-400">{lt.endTime ? formatDateTime(lt.endTime) : '—'}</td>
                  <td className="py-2.5 px-4 text-xs text-surface-400">{formatDateTime(lt.creationTimestamp)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
