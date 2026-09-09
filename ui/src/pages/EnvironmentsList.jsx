import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { FlaskConical, Server, ChevronRight, Plus, Download } from 'lucide-react';
import { fetchEnvironments, fetchEnvironmentYAML, downloadTextAsFile, createEnvironmentFromYAML } from '../api/client';
import PhaseBadge from '../components/PhaseBadge';
import ResourceTable from '../components/ResourceTable';
import { env as envState, phase, toneText } from '../lib/crstate';
import { useResource } from '../lib/useResource';
import { formatDate } from '../lib/format';

const COLUMNS = [
  { label: 'Name' },
  { label: 'Namespace' },
  { label: 'Phase' },
  { label: 'Nodes' },
  { label: 'Created' },
  { label: '' },
];

export default function EnvironmentsList() {
  const [search, setSearch] = useState('');
  const [uploading, setUploading] = useState(false);
  const navigate = useNavigate();

  const { data, loading, error, reload, setError } = useResource(
    ({ signal }) => fetchEnvironments({ signal }),
    { pollMs: 5000 },
  );
  const environments = data || [];

  const handleDownloadYAML = async (e, env) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      const yaml = await fetchEnvironmentYAML(env.namespace, env.name);
      downloadTextAsFile(yaml, `environment-${env.namespace}-${env.name}.yaml`, 'application/yaml');
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
      const summary = await createEnvironmentFromYAML(text);
      await reload();
      navigate(`/environments/${summary.namespace}/${summary.name}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  };

  const filtered = environments.filter(env =>
    env.name.toLowerCase().includes(search.toLowerCase()) ||
    (env.phase || '').toLowerCase().includes(search.toLowerCase()) ||
    env.namespace.toLowerCase().includes(search.toLowerCase())
  );

  const provisioningCount = environments.filter(e => envState.provisioning(e.phase)).length;

  const stats = [
    { label: 'Total', value: environments.length, color: 'text-white' },
    { label: 'Ready', value: environments.filter(e => e.phase === 'Ready').length, color: toneText(phase('env', 'Ready').tone) },
    { label: 'Provisioning', value: provisioningCount, color: 'text-blue-400' },
    { label: 'Failed', value: environments.filter(e => e.phase === 'Failed').length, color: toneText(phase('env', 'Failed').tone) },
  ];

  const renderRow = (env, i) => (
    <tr key={`${env.namespace}/${env.name}`} className="border-b border-surface-800/50 hover:bg-surface-800/30 transition-colors group animate-slide-up" style={{ animationDelay: `${i * 50}ms` }}>
      <td className="py-3.5 px-5">
        <Link to={`/environments/${env.namespace}/${env.name}`} className="font-semibold text-white group-hover:text-dfaas-400 transition-colors">{env.name}</Link>
      </td>
      <td className="py-3.5 px-5"><span className="text-xs font-mono text-surface-400 px-2 py-1 bg-surface-800/50 rounded-lg">{env.namespace}</span></td>
      <td className="py-3.5 px-5"><PhaseBadge kind="env" phase={env.phase} size="sm" /></td>
      <td className="py-3.5 px-5">
        <span className="flex items-center gap-1.5 text-sm text-surface-300">
          <Server className="w-3.5 h-3.5 text-surface-450" />
          {env.nodeCount}
          <span className="text-[12px] text-surface-450 ml-1">
            ({env.dfaasNodeCount}d / {env.k6NodeCount}k6)
          </span>
        </span>
      </td>
      <td className="py-3.5 px-5"><span className="text-sm text-surface-400">{formatDate(env.creationTimestamp)}</span></td>
      <td className="py-3.5 px-2">
        <div className="flex items-center justify-end gap-1">
          <button
            type="button"
            onClick={(e) => handleDownloadYAML(e, env)}
            title="Download CR YAML"
            aria-label="Download CR YAML"
            className="p-1.5 rounded-lg text-surface-400 hover:text-dfaas-400 hover:bg-surface-800/60 transition-colors"
          >
            <Download className="w-4 h-4" />
          </button>
          {/* Hover affordance only: the name cell is already a named link to the
              same URL, so naming this one announces the destination twice.
              aria-hidden needs tabIndex=-1 beside it — an aria-hidden element
              that can still take focus is itself a violation. */}
          <Link to={`/environments/${env.namespace}/${env.name}`} aria-hidden="true" tabIndex={-1} className="opacity-0 group-hover:opacity-100 transition-opacity"><ChevronRight className="w-5 h-5 text-surface-450" /></Link>
        </div>
      </td>
    </tr>
  );

  return (
    <ResourceTable
      title="Environments"
      subtitle="DFaaS infrastructure federations across all namespaces"
      titleIcon={FlaskConical}
      titleId="environments-title"
      onRefresh={reload}
      loading={loading}
      refreshId="refresh-btn"
      upload={{
        onChange: handleUploadYAML,
        uploading,
        id: 'upload-environment-yaml-btn',
        title: 'Create Environment from a CR YAML file',
      }}
      actions={(
        <Link to="/environments/new" className="btn-primary" id="new-environment-btn">
          <Plus className="w-4 h-4" />
          New Environment
        </Link>
      )}
      stats={stats}
      statsCols="grid-cols-4"
      search={search}
      onSearch={setSearch}
      searchPlaceholder="Search by name, phase or namespace..."
      searchId="search-environments"
      error={error}
      errorHint={<p className="text-surface-450 text-xs mt-2">Verify the backend is running and connected to the cluster.</p>}
      columns={COLUMNS}
      items={filtered}
      totalCount={environments.length}
      renderRow={renderRow}
      emptyIcon={FlaskConical}
      emptyText="No environments found"
      loadingText="Loading environments..."
      tableId="environments-table"
    />
  );
}
