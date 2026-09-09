import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Database, RefreshCw, Search, ChevronRight, Plus, Trash2, Cloud, Server, Info } from 'lucide-react';
import { listS3Configs, deleteS3Config } from '../api/client';
import { formatDate } from '../lib/format';
import { useResource } from '../lib/useResource';

const DAY_MS = 24 * 60 * 60 * 1000;
// Built-in S3 config the operator provisions at startup for the in-cluster SeaweedFS.
const DEFAULT_S3_CONFIG = 'seaweedfs-default';

export default function S3ConfigsList() {
  const [search, setSearch] = useState('');
  const [deletingName, setDeletingName] = useState(null);

  const { data, loading, error, reload, setError } = useResource(
    ({ signal }) => listS3Configs({ signal }),
  );
  const configs = data || [];

  const handleDelete = async (e, cfg) => {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm(`Delete S3 configuration '${cfg.name}'? Environments still referencing it will fail at export time.`)) return;
    setDeletingName(cfg.name);
    try {
      await deleteS3Config(cfg.name);
      await reload();
    } catch (err) {
      setError(err.message);
    } finally {
      setDeletingName(null);
    }
  };

  const filtered = configs.filter(c => {
    const q = search.toLowerCase();
    return (
      c.name.toLowerCase().includes(q) ||
      (c.endpoint || '').toLowerCase().includes(q) ||
      (c.region || '').toLowerCase().includes(q)
    );
  });

  const awsCount = configs.filter(c => !c.endpoint).length;
  const customCount = configs.filter(c => !!c.endpoint).length;
  const now = Date.now();
  const recentCount = configs.filter(c => now - new Date(c.createdAt).getTime() < DAY_MS).length;

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-3" id="s3-configs-title">
            <Database className="w-7 h-7 text-dfaas-400" />
            S3 Configurations
          </h1>
          <p className="text-sm text-surface-400 mt-1">
            Cluster-scoped registry of S3-compatible storage endpoints. Environments pick one via <code>spec.s3ConfigRef.name</code>.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={reload} className="btn-secondary" id="refresh-s3-btn">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
          <Link to="/s3-configs/new" className="btn-primary" id="new-s3-config-btn">
            <Plus className="w-4 h-4" />
            New S3 Config
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-4">
        {[
          { label: 'Total', value: configs.length, color: 'text-white' },
          { label: 'AWS (default endpoint)', value: awsCount, color: 'text-amber-400' },
          { label: 'Custom endpoint', value: customCount, color: 'text-violet-400' },
          { label: 'Created last 24h', value: recentCount, color: 'text-emerald-400' },
        ].map(stat => (
          <div key={stat.label} className="glass-card p-4">
            <p className="text-xs text-surface-450 uppercase tracking-wider">{stat.label}</p>
            <p className={`text-2xl font-bold mt-1 ${stat.color}`}>{stat.value}</p>
          </div>
        ))}
      </div>

      <div className="relative">
        <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-surface-450" />
        <input
          type="text"
          id="search-s3-configs"
          aria-label="Search by name, endpoint or region"
          placeholder="Search by name, endpoint or region..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="input pl-11"
        />
      </div>

      {error && (
        <div className="glass-card p-6 border-red-500/30 bg-red-500/5 text-center">
          <p className="text-red-400 text-sm">{error}</p>
          <p className="text-surface-450 text-xs mt-2">
            Verify the backend is running and that the <code>dfaas-s3</code> namespace exists.
          </p>
        </div>
      )}

      {!error && (
        <p className="flex items-center gap-2 text-xs text-surface-400">
          <Info className="w-3.5 h-3.5 text-dfaas-400 flex-shrink-0" />
          When an Environment sets no S3 config, exports and k6 payloads use the in-cluster SeaweedFS (<code>seaweedfs-default</code>).
        </p>
      )}

      {!error && (
        <div className="glass-card overflow-hidden">
          <table className="w-full" id="s3-configs-table">
            <thead>
              <tr className="border-b border-surface-700/50">
                <th className="text-left py-3.5 px-5 text-xs font-semibold text-surface-400 uppercase tracking-wider">Name</th>
                <th className="text-left py-3.5 px-5 text-xs font-semibold text-surface-400 uppercase tracking-wider">Endpoint</th>
                <th className="text-left py-3.5 px-5 text-xs font-semibold text-surface-400 uppercase tracking-wider">Region</th>
                <th className="text-left py-3.5 px-5 text-xs font-semibold text-surface-400 uppercase tracking-wider">Created</th>
                <th className="w-24"></th>
              </tr>
            </thead>
            <tbody>
              {loading && configs.length === 0 ? (
                <tr><td colSpan="5" className="text-center py-12 text-surface-450">
                  <div className="flex flex-col items-center gap-3">
                    <div className="w-8 h-8 border-2 border-dfaas-500/30 border-t-dfaas-500 rounded-full animate-spin" />
                    <span className="text-sm">Loading S3 configurations...</span>
                  </div>
                </td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan="5" className="text-center py-12 text-surface-450">
                  <Database className="w-10 h-10 mx-auto mb-3 opacity-30" />
                  <p className="text-sm">
                    No S3 configs yet — create one to enable bucket-per-environment metrics export.
                  </p>
                </td></tr>
              ) : filtered.map((cfg, i) => {
                const isAWS = !cfg.endpoint;
                const isDefault = cfg.name === DEFAULT_S3_CONFIG;
                return (
                  <tr
                    key={cfg.name}
                    className="border-b border-surface-800/50 hover:bg-surface-800/30 transition-colors group animate-slide-up"
                    style={{ animationDelay: `${i * 40}ms` }}
                  >
                    <td className="py-3.5 px-5">
                      <span className="inline-flex items-center gap-2">
                        <span className="font-semibold text-white group-hover:text-dfaas-400 transition-colors">
                          {cfg.name}
                        </span>
                        {isDefault && (
                          <span className="text-[12px] font-medium px-2 py-0.5 rounded-md bg-dfaas-500/15 text-dfaas-300 border border-dfaas-500/30">
                            built-in default
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="py-3.5 px-5">
                      <span className="flex items-center gap-1.5 text-xs font-mono text-surface-300">
                        {isAWS
                          ? (<><Cloud className="w-3.5 h-3.5 text-amber-400" /><span className="text-amber-300">AWS default</span></>)
                          : (<><Server className="w-3.5 h-3.5 text-violet-400" />{cfg.endpoint}</>)}
                      </span>
                    </td>
                    <td className="py-3.5 px-5">
                      <span className="text-xs font-mono text-surface-300 px-2 py-1 bg-surface-800/50 rounded-lg">
                        {cfg.region}
                      </span>
                    </td>
                    <td className="py-3.5 px-5">
                      <span className="text-sm text-surface-400">
                        {formatDate(cfg.createdAt)}
                      </span>
                    </td>
                    <td className="py-3.5 px-2">
                      <div className="flex items-center justify-end gap-1">
                        {!isDefault && (
                          <button
                            type="button"
                            onClick={(e) => handleDelete(e, cfg)}
                            disabled={deletingName === cfg.name}
                            title="Delete S3 configuration"
                            aria-label="Delete S3 configuration"
                            className="p-1.5 rounded-lg text-surface-400 hover:text-red-400 hover:bg-surface-800/60 transition-colors disabled:opacity-40"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        )}
                        <ChevronRight className="w-5 h-5 text-surface-450 opacity-0 group-hover:opacity-100 transition-opacity" />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
