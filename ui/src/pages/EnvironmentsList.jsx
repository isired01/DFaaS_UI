import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { FlaskConical, RefreshCw, Search, Server, ChevronRight, Plus } from 'lucide-react';
import { fetchEnvironments } from '../api/client';
import PhaseBadge from '../components/PhaseBadge';

const PROVISIONING_PHASES = new Set(['ProvisioningVMs', 'ProvisioningK6', 'ProvisioningMonitoring']);

export default function EnvironmentsList() {
  const [environments, setEnvironments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');

  const load = async () => {
    try {
      setError(null);
      const data = await fetchEnvironments();
      setEnvironments(data);
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); const interval = setInterval(load, 5000); return () => clearInterval(interval); }, []);

  const filtered = environments.filter(env =>
    env.name.toLowerCase().includes(search.toLowerCase()) ||
    (env.phase || '').toLowerCase().includes(search.toLowerCase()) ||
    env.namespace.toLowerCase().includes(search.toLowerCase())
  );

  const provisioningCount = environments.filter(e => PROVISIONING_PHASES.has(e.phase)).length;

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-3" id="environments-title">
            <FlaskConical className="w-7 h-7 text-dfaas-400" />
            Environments
          </h1>
          <p className="text-sm text-surface-400 mt-1">dFaaS infrastructure federations across all namespaces</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => { setLoading(true); load(); }} className="btn-secondary" id="refresh-btn">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
          <Link to="/environments/new" className="btn-primary" id="new-environment-btn">
            <Plus className="w-4 h-4" />
            New Environment
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-4">
        {[
          { label: 'Total', value: environments.length, color: 'text-white' },
          { label: 'Ready', value: environments.filter(e => e.phase === 'Ready').length, color: 'text-emerald-400' },
          { label: 'Provisioning', value: provisioningCount, color: 'text-blue-400' },
          { label: 'Failed', value: environments.filter(e => e.phase === 'Failed').length, color: 'text-red-400' },
        ].map(stat => (
          <div key={stat.label} className="glass-card p-4">
            <p className="text-xs text-surface-500 uppercase tracking-wider">{stat.label}</p>
            <p className={`text-2xl font-bold mt-1 ${stat.color}`}>{stat.value}</p>
          </div>
        ))}
      </div>

      <div className="relative">
        <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-surface-500" />
        <input type="text" id="search-environments" placeholder="Search by name, phase or namespace..." value={search} onChange={(e) => setSearch(e.target.value)} className="input pl-11" />
      </div>

      {error && (
        <div className="glass-card p-6 border-red-500/30 bg-red-500/5 text-center">
          <p className="text-red-400 text-sm">{error}</p>
          <p className="text-surface-500 text-xs mt-2">Verify the backend is running and connected to the cluster.</p>
        </div>
      )}

      {!error && (
        <div className="glass-card overflow-hidden">
          <table className="w-full" id="environments-table">
            <thead>
              <tr className="border-b border-surface-700/50">
                <th className="text-left py-3.5 px-5 text-xs font-semibold text-surface-400 uppercase tracking-wider">Name</th>
                <th className="text-left py-3.5 px-5 text-xs font-semibold text-surface-400 uppercase tracking-wider">Namespace</th>
                <th className="text-left py-3.5 px-5 text-xs font-semibold text-surface-400 uppercase tracking-wider">Phase</th>
                <th className="text-left py-3.5 px-5 text-xs font-semibold text-surface-400 uppercase tracking-wider">Nodes</th>
                <th className="text-left py-3.5 px-5 text-xs font-semibold text-surface-400 uppercase tracking-wider">Created</th>
                <th className="w-12"></th>
              </tr>
            </thead>
            <tbody>
              {loading && environments.length === 0 ? (
                <tr><td colSpan="6" className="text-center py-12 text-surface-500">
                  <div className="flex flex-col items-center gap-3">
                    <div className="w-8 h-8 border-2 border-dfaas-500/30 border-t-dfaas-500 rounded-full animate-spin" />
                    <span className="text-sm">Loading environments...</span>
                  </div>
                </td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan="6" className="text-center py-12 text-surface-500">
                  <FlaskConical className="w-10 h-10 mx-auto mb-3 opacity-30" />
                  <p className="text-sm">No environments found</p>
                </td></tr>
              ) : filtered.map((env, i) => (
                <tr key={`${env.namespace}/${env.name}`} className="border-b border-surface-800/50 hover:bg-surface-800/30 transition-colors group animate-slide-up" style={{ animationDelay: `${i * 50}ms` }}>
                  <td className="py-3.5 px-5">
                    <Link to={`/environments/${env.namespace}/${env.name}`} className="font-semibold text-white group-hover:text-dfaas-400 transition-colors">{env.name}</Link>
                  </td>
                  <td className="py-3.5 px-5"><span className="text-xs font-mono text-surface-400 px-2 py-1 bg-surface-800/50 rounded-lg">{env.namespace}</span></td>
                  <td className="py-3.5 px-5"><PhaseBadge kind="env" phase={env.phase} size="sm" /></td>
                  <td className="py-3.5 px-5">
                    <span className="flex items-center gap-1.5 text-sm text-surface-300">
                      <Server className="w-3.5 h-3.5 text-surface-500" />
                      {env.nodeCount}
                      <span className="text-[10px] text-surface-500 ml-1">
                        ({env.dfaasNodeCount}d / {env.k6NodeCount}k6)
                      </span>
                    </span>
                  </td>
                  <td className="py-3.5 px-5"><span className="text-sm text-surface-400">{new Date(env.creationTimestamp).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</span></td>
                  <td className="py-3.5 px-2"><Link to={`/environments/${env.namespace}/${env.name}`} className="opacity-0 group-hover:opacity-100 transition-opacity"><ChevronRight className="w-5 h-5 text-surface-500" /></Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
