import { useState, useEffect, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { TestTube2, ChevronRight, Download } from 'lucide-react';
import { fetchLoadTests, fetchLoadTestYAML, downloadTextAsFile, createLoadTestFromYAML } from '../api/client';
import PhaseBadge from '../components/PhaseBadge';
import ResourceTable from '../components/ResourceTable';
import { formatDate } from '../lib/format';

const COLUMNS = [
  { label: 'Name' },
  { label: 'Namespace' },
  { label: 'Environment' },
  { label: 'Phase' },
  { label: 'Created' },
  { label: '' },
];

export default function LoadTestsList() {
  const [loadtests, setLoadtests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [uploading, setUploading] = useState(false);
  const navigate = useNavigate();

  const load = useCallback(async () => {
    try {
      setError(null);
      const data = await fetchLoadTests();
      setLoadtests(data);
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, [load]);

  const handleDownloadYAML = async (e, lt) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      const yaml = await fetchLoadTestYAML(lt.namespace, lt.name);
      downloadTextAsFile(yaml, `loadtest-${lt.namespace}-${lt.name}.yaml`, 'application/yaml');
    } catch (err) {
      setError(err.message);
    }
  };

  const handleUploadYAML = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      setError(null);
      const text = await file.text();
      const summary = await createLoadTestFromYAML(text);
      await load();
      navigate(`/loadtests/${summary.namespace}/${summary.name}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  };

  const filtered = loadtests.filter(lt =>
    lt.name.toLowerCase().includes(search.toLowerCase()) ||
    (lt.phase || '').toLowerCase().includes(search.toLowerCase()) ||
    lt.namespace.toLowerCase().includes(search.toLowerCase()) ||
    (lt.targetEnvironment || '').toLowerCase().includes(search.toLowerCase())
  );

  const stats = [
    { label: 'Total',      value: loadtests.length, color: 'text-white' },
    { label: 'Pending',    value: loadtests.filter(l => l.phase === 'Pending').length, color: 'text-surface-300' },
    { label: 'Running',    value: loadtests.filter(l => l.phase === 'Running').length, color: 'text-amber-400' },
    { label: 'Completed',  value: loadtests.filter(l => l.phase === 'Completed').length, color: 'text-emerald-400' },
    { label: 'Failed',     value: loadtests.filter(l => l.phase === 'Failed').length, color: 'text-red-400' },
    { label: 'Aborted',    value: loadtests.filter(l => l.phase === 'Aborted').length, color: 'text-slate-400' },
  ];

  const renderRow = (lt, i) => (
    <tr key={`${lt.namespace}/${lt.name}`} className="border-b border-surface-800/50 hover:bg-surface-800/30 transition-colors group animate-slide-up" style={{ animationDelay: `${i * 50}ms` }}>
      <td className="py-3.5 px-5">
        <Link to={`/loadtests/${lt.namespace}/${lt.name}`} className="font-semibold text-white group-hover:text-dfaas-400 transition-colors">{lt.name}</Link>
      </td>
      <td className="py-3.5 px-5"><span className="text-xs font-mono text-surface-400 px-2 py-1 bg-surface-800/50 rounded-lg">{lt.namespace}</span></td>
      <td className="py-3.5 px-5">
        <Link to={`/environments/${lt.namespace}/${lt.targetEnvironment}`} className="text-xs font-mono text-dfaas-400 hover:text-dfaas-300 transition-colors">{lt.targetEnvironment}</Link>
      </td>
      <td className="py-3.5 px-5"><PhaseBadge kind="loadtest" phase={lt.phase} size="sm" /></td>
      <td className="py-3.5 px-5"><span className="text-sm text-surface-400">{formatDate(lt.creationTimestamp)}</span></td>
      <td className="py-3.5 px-2">
        <div className="flex items-center justify-end gap-1">
          <button
            type="button"
            onClick={(e) => handleDownloadYAML(e, lt)}
            title="Download CR YAML"
            aria-label="Download CR YAML"
            className="p-1.5 rounded-lg text-surface-400 hover:text-dfaas-400 hover:bg-surface-800/60 transition-colors"
          >
            <Download className="w-4 h-4" />
          </button>
          <Link to={`/loadtests/${lt.namespace}/${lt.name}`} className="opacity-0 group-hover:opacity-100 transition-opacity"><ChevronRight className="w-5 h-5 text-surface-500" /></Link>
        </div>
      </td>
    </tr>
  );

  return (
    <ResourceTable
      title="Load Tests"
      subtitle="k6 load tests across all environments"
      titleIcon={TestTube2}
      titleIconClassName="w-7 h-7 text-amber-400"
      onRefresh={() => { setLoading(true); load(); }}
      loading={loading}
      upload={{
        onChange: handleUploadYAML,
        uploading,
        id: 'upload-loadtest-yaml-btn',
        title: 'Create LoadTest from a CR YAML file',
      }}
      stats={stats}
      statsCols="grid-cols-6"
      search={search}
      onSearch={setSearch}
      searchPlaceholder="Search by name, phase, namespace or environment..."
      error={error}
      columns={COLUMNS}
      items={filtered}
      totalCount={loadtests.length}
      renderRow={renderRow}
      emptyIcon={TestTube2}
      emptyText="No load tests found"
      loadingText="Loading load tests..."
    />
  );
}
