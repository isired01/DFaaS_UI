import { useState, useEffect, useCallback, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { TestTube2, ChevronRight, Download, Plus, X } from 'lucide-react';
import { fetchLoadTests, fetchLoadTestYAML, downloadTextAsFile, createLoadTestFromYAML, fetchEnvironments } from '../api/client';
import PhaseBadge from '../components/PhaseBadge';
import ResourceTable from '../components/ResourceTable';
import ErrorAlert from '../components/ErrorAlert';
import { formatDate } from '../lib/format';
import { DISPATCHABLE_ENV_PHASES } from '../lib/constants';

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

  // New-LoadTest flow: a LoadTest is scoped to a Ready Environment, so the
  // create button first opens a modal to pick one, then routes to that env's form.
  const dialogRef = useRef(null);
  const [envs, setEnvs] = useState([]);
  const [envsLoading, setEnvsLoading] = useState(false);
  const [envsError, setEnvsError] = useState(null);

  const openNewDialog = async () => {
    dialogRef.current?.showModal();
    setEnvsLoading(true);
    setEnvsError(null);
    try {
      setEnvs(await fetchEnvironments());
    } catch (err) {
      setEnvsError(err.message);
    } finally {
      setEnvsLoading(false);
    }
  };

  const pickEnv = (env) => {
    dialogRef.current?.close();
    navigate(`/environments/${env.namespace}/${env.name}/loadtests/new`);
  };

  // Native <dialog> dispatches a click with target === the dialog when the
  // ::backdrop is clicked; content clicks target inner nodes. Close on backdrop.
  const onDialogClick = (e) => {
    if (e.target === dialogRef.current) dialogRef.current.close();
  };

  // Same guard as EnvironmentsList: skip overlapping polls, cancel on unmount,
  // and clear the error only on success so a failure stays readable instead of
  // being wiped by the next tick.
  const inFlight = useRef(false);
  const abortRef = useRef(null);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const data = await fetchLoadTests({ signal: controller.signal });
      setLoadtests(data);
      setError(null);
    } catch (err) {
      if (err?.name !== 'AbortError') setError(err.message);
    } finally {
      // Only the newest request may clear the guard — see EnvironmentsList.
      if (abortRef.current === controller) {
        inFlight.current = false;
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 5000);
    return () => {
      clearInterval(interval);
      abortRef.current?.abort();
      // Release the guard synchronously so StrictMode's second mount loads
      // immediately instead of waiting out the 5s interval.
      abortRef.current = null;
      inFlight.current = false;
    };
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
          <Link to={`/loadtests/${lt.namespace}/${lt.name}`} className="opacity-0 group-hover:opacity-100 transition-opacity"><ChevronRight className="w-5 h-5 text-surface-450" /></Link>
        </div>
      </td>
    </tr>
  );

  return (
    <>
      <ResourceTable
        title="Load Tests"
        subtitle="k6 load tests across all environments"
        titleIcon={TestTube2}
        titleIconClassName="w-7 h-7 text-amber-400"
        onRefresh={() => { setLoading(true); load(); }}
        loading={loading}
        actions={(
          <button type="button" onClick={openNewDialog} className="btn-primary" id="new-loadtest-btn">
            <Plus className="w-4 h-4" />
            New Load Test
          </button>
        )}
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

      <dialog
        ref={dialogRef}
        onClick={onDialogClick}
        className="backdrop:bg-black/60 bg-transparent p-0 m-auto w-full max-w-md"
      >
        <div className="glass-card p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-white">Select an environment</h2>
            <button
              type="button"
              onClick={() => dialogRef.current?.close()}
              aria-label="Close"
              className="p-1.5 rounded-lg text-surface-400 hover:text-white hover:bg-surface-800/60 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <p className="text-xs text-surface-400">A load test runs against a <strong className="text-surface-300">Ready</strong> or <strong className="text-surface-300">Degraded</strong> environment — pick one to continue to the create form.</p>

          {envsLoading ? (
            <div className="flex items-center justify-center py-10">
              <div className="w-8 h-8 border-3 border-dfaas-500/30 border-t-dfaas-500 rounded-full animate-spin" />
            </div>
          ) : envsError ? (
            <ErrorAlert message={envsError} />
          ) : envs.length === 0 ? (
            <div className="text-sm text-surface-400 text-center py-6">
              No environments yet.{' '}
              <Link to="/environments/new" onClick={() => dialogRef.current?.close()} className="text-dfaas-400 hover:text-dfaas-300">Create one first.</Link>
            </div>
          ) : (
            <ul className="space-y-2 max-h-80 overflow-y-auto">
              {envs.map((env) => {
                const dispatchable = DISPATCHABLE_ENV_PHASES.has(env.phase);
                return (
                  <li key={`${env.namespace}/${env.name}`}>
                    <button
                      type="button"
                      disabled={!dispatchable}
                      onClick={() => pickEnv(env)}
                      title={dispatchable ? undefined : `Environment must be Ready or Degraded (currently ${env.phase})`}
                      className="w-full flex items-center justify-between gap-3 p-3 rounded-xl border border-surface-800 bg-surface-800/30 text-left transition-colors enabled:hover:bg-surface-800/60 enabled:hover:border-dfaas-500/40 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <div className="min-w-0">
                        <div className="font-semibold text-white truncate">{env.name}</div>
                        <div className="text-xs font-mono text-surface-400 truncate">{env.namespace}</div>
                      </div>
                      <PhaseBadge kind="env" phase={env.phase} size="sm" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </dialog>
    </>
  );
}
