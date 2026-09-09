import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Database, Cloud, Server, Info } from 'lucide-react';
import { fetchS3Config } from '../api/client';
import LoadingSpinner from '../components/LoadingSpinner';
import PageError from '../components/PageError';
import { formatDate } from '../lib/format';
import { useResource } from '../lib/useResource';

// Built-in S3 config the operator provisions at startup for the in-cluster
// SeaweedFS. The API does not flag it explicitly, so we derive it by name the
// same way S3ConfigsList does.
const DEFAULT_S3_CONFIG = 'seaweedfs-default';

export default function S3ConfigDetail() {
  const { name } = useParams();
  const { data: config, loading, error } = useResource(
    ({ signal }) => fetchS3Config(name, { signal }),
    { deps: [name] },
  );

  if (loading) return <LoadingSpinner />;

  if (error) return <PageError message={error} back={{ to: '/s3-configs', label: 'Back to S3 Configurations' }} />;

  if (!config) return null;

  const isDefault = config.name === DEFAULT_S3_CONFIG;
  const isAWS = !config.endpoint;

  const fields = [
    {
      label: 'Endpoint',
      value: isAWS ? (
        <span className="inline-flex items-center gap-1.5 text-amber-300">
          <Cloud className="w-4 h-4 text-amber-400" />AWS default
        </span>
      ) : (
        <span className="inline-flex items-center gap-1.5 text-surface-200">
          <Server className="w-4 h-4 text-violet-400" />{config.endpoint}
        </span>
      ),
    },
    { label: 'Region', value: config.region || '—' },
    { label: 'Force path style', value: config.forcePathStyle ? 'true' : 'false' },
    { label: 'Created', value: config.createdAt ? formatDate(config.createdAt) : '—' },
  ];

  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <Link to="/s3-configs" className="inline-flex items-center gap-1.5 text-sm text-surface-400 hover:text-white transition-colors mb-4">
          <ArrowLeft className="w-4 h-4" />Back to S3 Configurations
        </Link>
        <h1 className="text-2xl font-bold text-white flex items-center gap-3" id="s3-config-name">
          <Database className="w-7 h-7 text-dfaas-400" />
          {config.name}
          {isDefault && (
            <span className="text-[12px] font-medium px-2 py-0.5 rounded-md bg-dfaas-500/15 text-dfaas-300 border border-dfaas-500/30">
              built-in default
            </span>
          )}
        </h1>
        <p className="text-sm text-surface-400 mt-1">
          Environments reference this config via <code>spec.s3ConfigRef.name</code>.
        </p>
      </div>

      <div className="glass-card p-5">
        <h2 className="text-sm font-semibold text-surface-300 uppercase tracking-wider mb-4">Configuration</h2>
        <dl className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {fields.map(f => (
            <div key={f.label}>
              <dt className="text-xs text-surface-450 uppercase tracking-wider">{f.label}</dt>
              <dd className="text-sm font-mono text-surface-200 mt-1">{f.value}</dd>
            </div>
          ))}
        </dl>
      </div>

      <p className="flex items-center gap-2 text-xs text-surface-400">
        <Info className="w-3.5 h-3.5 text-dfaas-400 flex-shrink-0" />
        Access and secret keys are stored in the underlying <code>dfaas-s3</code> Secret and never returned by the API.
      </p>
    </div>
  );
}
