import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { TestTube2, RefreshCw, Search, ChevronRight } from 'lucide-react';
import { fetchLoadTests } from '../api/client';
import PhaseBadge from '../components/PhaseBadge';

export default function LoadTestsList() {
  const [loadtests, setLoadtests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');

  const load = async () => {
    try {
      setError(null);
      const data = await fetchLoadTests();
      setLoadtests(data);
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); const interval = setInterval(load, 5000); return () => clearInterval(interval); }, []);

  const filtered = loadtests.filter(lt =>
    lt.name.toLowerCase().includes(search.toLowerCase()) ||
    (lt.phase || '').toLowerCase().includes(search.toLowerCase()) ||
    lt.namespace.toLowerCase().includes(search.toLowerCase()) ||
    (lt.targetEnvironment || '').toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-3">
            <TestTube2 className="w-7 h-7 text-amber-400" />
            Load Tests
          </h1>
          <p className="text-sm text-surface-400 mt-1">k6 load tests across all environments</p>
        </div>
        <button onClick={() => { setLoading(true); load(); }} className="btn-secondary">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      <div className="grid grid-cols-6 gap-4">
        {[
          { label: 'Total',      value: loadtests.length, color: 'text-white' },
          { label: 'Pending',    value: loadtests.filter(l => l.phase === 'Pending').length, color: 'text-surface-300' },
          { label: 'Running',    value: loadtests.filter(l => l.phase === 'Running').length, color: 'text-amber-400' },
          { label: 'Completed',  value: loadtests.filter(l => l.phase === 'Completed').length, color: 'text-emerald-400' },
          { label: 'Failed',     value: loadtests.filter(l => l.phase === 'Failed').length, color: 'text-red-400' },
          { label: 'Aborted',    value: loadtests.filter(l => l.phase === 'Aborted').length, color: 'text-slate-400' },
        ].map(stat => (
          <div key={stat.label} className="glass-card p-4">
            <p className="text-xs text-surface-500 uppercase tracking-wider">{stat.label}</p>
            <p className={`text-2xl font-bold mt-1 ${stat.color}`}>{stat.value}</p>
          </div>
        ))}
      </div>

      <div className="relative">
        <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-surface-500" />
        <input type="text" placeholder="Search by name, phase, namespace or environment..." value={search} onChange={(e) => setSearch(e.target.value)} className="input pl-11" />
      </div>

      {error && (
        <div className="glass-card p-6 border-red-500/30 bg-red-500/5 text-center">
          <p className="text-red-400 text-sm">{error}</p>
        </div>
      )}

      {!error && (
        <div className="glass-card overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-surface-700/50">
                <th className="text-left py-3.5 px-5 text-xs font-semibold text-surface-400 uppercase tracking-wider">Name</th>
                <th className="text-left py-3.5 px-5 text-xs font-semibold text-surface-400 uppercase tracking-wider">Namespace</th>
                <th className="text-left py-3.5 px-5 text-xs font-semibold text-surface-400 uppercase tracking-wider">Environment</th>
                <th className="text-left py-3.5 px-5 text-xs font-semibold text-surface-400 uppercase tracking-wider">Phase</th>
                <th className="text-left py-3.5 px-5 text-xs font-semibold text-surface-400 uppercase tracking-wider">Created</th>
                <th className="w-12"></th>
              </tr>
            </thead>
            <tbody>
              {loading && loadtests.length === 0 ? (
                <tr><td colSpan="6" className="text-center py-12 text-surface-500">
                  <div className="flex flex-col items-center gap-3">
                    <div className="w-8 h-8 border-2 border-dfaas-500/30 border-t-dfaas-500 rounded-full animate-spin" />
                    <span className="text-sm">Loading load tests...</span>
                  </div>
                </td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan="6" className="text-center py-12 text-surface-500">
                  <TestTube2 className="w-10 h-10 mx-auto mb-3 opacity-30" />
                  <p className="text-sm">No load tests found</p>
                </td></tr>
              ) : filtered.map((lt, i) => (
                <tr key={`${lt.namespace}/${lt.name}`} className="border-b border-surface-800/50 hover:bg-surface-800/30 transition-colors group animate-slide-up" style={{ animationDelay: `${i * 50}ms` }}>
                  <td className="py-3.5 px-5">
                    <Link to={`/loadtests/${lt.namespace}/${lt.name}`} className="font-semibold text-white group-hover:text-dfaas-400 transition-colors">{lt.name}</Link>
                  </td>
                  <td className="py-3.5 px-5"><span className="text-xs font-mono text-surface-400 px-2 py-1 bg-surface-800/50 rounded-lg">{lt.namespace}</span></td>
                  <td className="py-3.5 px-5">
                    <Link to={`/environments/${lt.namespace}/${lt.targetEnvironment}`} className="text-xs font-mono text-dfaas-400 hover:text-dfaas-300 transition-colors">{lt.targetEnvironment}</Link>
                  </td>
                  <td className="py-3.5 px-5"><PhaseBadge kind="loadtest" phase={lt.phase} size="sm" /></td>
                  <td className="py-3.5 px-5"><span className="text-sm text-surface-400">{new Date(lt.creationTimestamp).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</span></td>
                  <td className="py-3.5 px-2"><Link to={`/loadtests/${lt.namespace}/${lt.name}`} className="opacity-0 group-hover:opacity-100 transition-opacity"><ChevronRight className="w-5 h-5 text-surface-500" /></Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
