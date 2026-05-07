import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { FlaskConical, RefreshCw, Search, Server, ChevronRight } from 'lucide-react';
import { fetchExperiments } from '../api/client';
import PhaseBadge from '../components/PhaseBadge';

export default function Dashboard() {
  const [experiments, setExperiments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');

  const load = async () => {
    try {
      setError(null);
      const data = await fetchExperiments();
      setExperiments(data);
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); const interval = setInterval(load, 5000); return () => clearInterval(interval); }, []);

  const filtered = experiments.filter(exp =>
    exp.name.toLowerCase().includes(search.toLowerCase()) ||
    exp.phase.toLowerCase().includes(search.toLowerCase()) ||
    exp.namespace.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-3" id="dashboard-title">
            <FlaskConical className="w-7 h-7 text-dfaas-400" />
            Experiments
          </h1>
          <p className="text-sm text-surface-400 mt-1">Gestione esperimenti dFaaS su tutti i namespace</p>
        </div>
        <button onClick={() => { setLoading(true); load(); }} className="btn-secondary" id="refresh-btn">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4">
        {[
          { label: 'Totali', value: experiments.length, color: 'text-white' },
          { label: 'Ready', value: experiments.filter(e => e.phase === 'READY').length, color: 'text-emerald-400' },
          { label: 'Running', value: experiments.filter(e => e.phase === 'RUNNING').length, color: 'text-amber-400' },
          { label: 'Failed', value: experiments.filter(e => e.phase === 'FAILED').length, color: 'text-red-400' },
        ].map(stat => (
          <div key={stat.label} className="glass-card p-4">
            <p className="text-xs text-surface-500 uppercase tracking-wider">{stat.label}</p>
            <p className={`text-2xl font-bold mt-1 ${stat.color}`}>{stat.value}</p>
          </div>
        ))}
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-surface-500" />
        <input type="text" id="search-experiments" placeholder="Cerca per nome, fase o namespace..." value={search} onChange={(e) => setSearch(e.target.value)} className="input pl-11" />
      </div>

      {/* Error */}
      {error && (
        <div className="glass-card p-6 border-red-500/30 bg-red-500/5 text-center">
          <p className="text-red-400 text-sm">{error}</p>
          <p className="text-surface-500 text-xs mt-2">Verifica che il backend sia avviato e connesso al cluster.</p>
        </div>
      )}

      {/* Table */}
      {!error && (
        <div className="glass-card overflow-hidden">
          <table className="w-full" id="experiments-table">
            <thead>
              <tr className="border-b border-surface-700/50">
                <th className="text-left py-3.5 px-5 text-xs font-semibold text-surface-400 uppercase tracking-wider">Nome</th>
                <th className="text-left py-3.5 px-5 text-xs font-semibold text-surface-400 uppercase tracking-wider">Namespace</th>
                <th className="text-left py-3.5 px-5 text-xs font-semibold text-surface-400 uppercase tracking-wider">Fase</th>
                <th className="text-left py-3.5 px-5 text-xs font-semibold text-surface-400 uppercase tracking-wider">Nodi</th>
                <th className="text-left py-3.5 px-5 text-xs font-semibold text-surface-400 uppercase tracking-wider">Creato</th>
                <th className="w-12"></th>
              </tr>
            </thead>
            <tbody>
              {loading && experiments.length === 0 ? (
                <tr><td colSpan="6" className="text-center py-12 text-surface-500">
                  <div className="flex flex-col items-center gap-3">
                    <div className="w-8 h-8 border-2 border-dfaas-500/30 border-t-dfaas-500 rounded-full animate-spin" />
                    <span className="text-sm">Caricamento esperimenti...</span>
                  </div>
                </td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan="6" className="text-center py-12 text-surface-500">
                  <FlaskConical className="w-10 h-10 mx-auto mb-3 opacity-30" />
                  <p className="text-sm">Nessun esperimento trovato</p>
                </td></tr>
              ) : filtered.map((exp, i) => (
                <tr key={`${exp.namespace}/${exp.name}`} className="border-b border-surface-800/50 hover:bg-surface-800/30 transition-colors group animate-slide-up" style={{ animationDelay: `${i * 50}ms` }}>
                  <td className="py-3.5 px-5">
                    <Link to={`/experiments/${exp.namespace}/${exp.name}`} className="font-semibold text-white group-hover:text-dfaas-400 transition-colors">{exp.name}</Link>
                  </td>
                  <td className="py-3.5 px-5"><span className="text-xs font-mono text-surface-400 px-2 py-1 bg-surface-800/50 rounded-lg">{exp.namespace}</span></td>
                  <td className="py-3.5 px-5"><PhaseBadge phase={exp.phase} size="sm" /></td>
                  <td className="py-3.5 px-5"><span className="flex items-center gap-1.5 text-sm text-surface-300"><Server className="w-3.5 h-3.5 text-surface-500" />{exp.nodeCount}</span></td>
                  <td className="py-3.5 px-5"><span className="text-sm text-surface-400">{new Date(exp.creationTimestamp).toLocaleDateString('it-IT', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</span></td>
                  <td className="py-3.5 px-2"><Link to={`/experiments/${exp.namespace}/${exp.name}`} className="opacity-0 group-hover:opacity-100 transition-opacity"><ChevronRight className="w-5 h-5 text-surface-500" /></Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
