import { useState, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Save, Database, Info } from 'lucide-react';
import { createS3Config } from '../api/client';
import FormField from '../components/FormField';

// DNS-1123: lowercase alphanumeric and '-', start/end alphanumeric, max 63.
const DNS1123_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

// Heuristic for endpoints that almost always want path-style addressing.
const PATH_STYLE_HINTS = ['minio', 'localhost', '127.0.0.1', '.svc'];

export default function S3ConfigNew() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [region, setRegion] = useState('us-east-1');
  const [accessKeyId, setAccessKeyId] = useState('');
  const [secretAccessKey, setSecretAccessKey] = useState('');
  const [forcePathStyle, setForcePathStyle] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const suggestPathStyle = useMemo(() => {
    const ep = endpoint.toLowerCase();
    return !!ep && PATH_STYLE_HINTS.some(h => ep.includes(h)) && !forcePathStyle;
  }, [endpoint, forcePathStyle]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    try {
      const trimmedName = name.trim();
      if (!trimmedName) throw new Error('Name is required');
      if (trimmedName.length > 63) throw new Error('Name must be 63 characters or fewer');
      if (!DNS1123_RE.test(trimmedName)) {
        throw new Error('Name must be DNS-1123: lowercase letters, digits and "-", start/end alphanumeric.');
      }
      if (!region.trim()) throw new Error('Region is required');
      if (!accessKeyId) throw new Error('Access Key ID is required');
      if (!secretAccessKey) throw new Error('Secret Access Key is required');

      setSubmitting(true);
      await createS3Config({
        name: trimmedName,
        endpoint: endpoint.trim(),
        region: region.trim(),
        accessKeyId,
        secretAccessKey,
        forcePathStyle,
      });
      navigate('/s3-configs');
    } catch (err) {
      setError(err.message);
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6 animate-fade-in max-w-3xl mx-auto">
      <div>
        <Link to="/s3-configs" className="inline-flex items-center gap-1.5 text-sm text-surface-400 hover:text-white transition-colors mb-4">
          <ArrowLeft className="w-4 h-4" />Back to S3 Configurations
        </Link>
        <h1 className="text-2xl font-bold text-white flex items-center gap-3">
          <Database className="w-7 h-7 text-dfaas-400" />
          New S3 Configuration
        </h1>
        <p className="text-sm text-surface-400 mt-1">
          Stored as <code>Secret dfaas-s3/&lt;name&gt;</code> with label <code>dfaas.io/s3-config=true</code>. Access and secret keys are write-only.
        </p>
      </div>

      <div className="glass-card p-5 space-y-4">
        <h2 className="text-sm font-semibold text-surface-300 uppercase tracking-wider">Identity</h2>
        <FormField
          label="Name"
          hint={<>DNS-1123: lowercase letters, digits and <code>-</code>. Max 63 characters. Immutable once created (delete + recreate to rename).</>}
        >
          <input
            type="text"
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="minio-eu-west-1"
            required
            maxLength={63}
          />
        </FormField>
      </div>

      <div className="glass-card p-5 space-y-4">
        <h2 className="text-sm font-semibold text-surface-300 uppercase tracking-wider">Endpoint</h2>
        <FormField label="S3 endpoint (optional)" hint="Leave empty to use the AWS default for the chosen region.">
          <input
            type="text"
            className="input"
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder="https://s3.amazonaws.com or http://minio.minio.svc:9000"
          />
        </FormField>
        <FormField label="Region">
          <input
            type="text"
            className="input"
            value={region}
            onChange={(e) => setRegion(e.target.value)}
            placeholder="eu-west-1"
            required
          />
        </FormField>
        <div>
          <label className="flex items-center gap-2 text-sm text-surface-300">
            <input
              type="checkbox"
              checked={forcePathStyle}
              onChange={(e) => setForcePathStyle(e.target.checked)}
            />
            Force path-style addressing
          </label>
          <p className="text-[10px] text-surface-500 mt-1">
            Enable for MinIO and most non-AWS endpoints (uses <code>{`http://host/bucket`}</code> instead of <code>{`http://bucket.host`}</code>).
          </p>
          {suggestPathStyle && (
            <div className="mt-2 p-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs flex items-start gap-2">
              <Info className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
              <span>
                This endpoint looks non-AWS — enabling path-style is recommended.
              </span>
            </div>
          )}
        </div>
      </div>

      <div className="glass-card p-5 space-y-4">
        <h2 className="text-sm font-semibold text-surface-300 uppercase tracking-wider">Credentials</h2>
        <p className="text-xs text-surface-500">
          Stored verbatim in the Secret. The gateway never echoes these values back on read.
        </p>
        <FormField label="Access Key ID">
          <input
            type="password"
            className="input"
            value={accessKeyId}
            onChange={(e) => setAccessKeyId(e.target.value)}
            autoComplete="off"
            required
          />
        </FormField>
        <FormField label="Secret Access Key">
          <input
            type="password"
            className="input"
            value={secretAccessKey}
            onChange={(e) => setSecretAccessKey(e.target.value)}
            autoComplete="off"
            required
          />
        </FormField>
      </div>

      {error && <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-sm">{error}</div>}

      <div className="flex items-center justify-end gap-3">
        <Link to="/s3-configs" className="btn-secondary">Cancel</Link>
        <button type="submit" disabled={submitting} className="btn-primary">
          {submitting
            ? <><div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />Creating...</>
            : <><Save className="w-4 h-4" />Create S3 Config</>}
        </button>
      </div>
    </form>
  );
}
