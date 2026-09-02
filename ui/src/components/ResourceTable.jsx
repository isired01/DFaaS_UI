import { useRef } from 'react';
import { RefreshCw, Search, Upload } from 'lucide-react';

// ResourceTable is the shared chrome for the cluster-wide list pages
// (Environments, Load Tests): header with refresh + YAML upload, a stats grid,
// a search box, an error panel, and a table that renders loading / empty / rows
// states. Columns and per-row markup are supplied by the caller so each page
// keeps its exact column set and cell rendering.
//
// Props:
// - title, subtitle, titleIcon (lucide component), titleId
// - onRefresh, loading
// - upload: { onChange, uploading, label, id, title } | null
// - actions: extra header nodes rendered after the upload button (e.g. New btn)
// - stats: [{ label, value, color }], statsCols (Tailwind grid-cols-N)
// - search, onSearch, searchPlaceholder, searchId
// - error
// - columns: [{ label, className?, thClassName? }] — last entry may be a
//   spacer header with no label.
// - items, totalCount (unfiltered count for the first-load spinner guard)
// - renderRow(item, index) — must set the row's React key
// - emptyIcon (lucide component), emptyText, loadingText
// - errorHint: optional node shown under the error message
export default function ResourceTable({
  title,
  subtitle,
  titleIcon: TitleIcon,
  titleIconClassName = 'w-7 h-7 text-dfaas-400',
  titleId,
  onRefresh,
  loading,
  refreshId,
  upload = null,
  actions = null,
  stats = [],
  statsCols = 'grid-cols-4',
  search,
  onSearch,
  searchPlaceholder,
  searchId,
  error,
  errorHint = null,
  columns = [],
  items = [],
  totalCount,
  renderRow,
  emptyIcon: EmptyIcon,
  emptyText,
  loadingText,
  tableId,
}) {
  const fileInputRef = useRef(null);
  const colSpan = columns.length;
  // Loading spinner shows only on the very first load (no data yet); falls back
  // to items length when the caller does not pass an unfiltered total.
  const initialLoad = (totalCount ?? items.length) === 0;

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-3" id={titleId}>
            {TitleIcon && <TitleIcon className={titleIconClassName} />}
            {title}
          </h1>
          <p className="text-sm text-surface-400 mt-1">{subtitle}</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={onRefresh} className="btn-secondary" id={refreshId}>
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
          {upload && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                aria-label="Import YAML"
                accept=".yaml,.yml,application/yaml,application/x-yaml,text/yaml"
                onChange={upload.onChange}
                className="hidden"
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="btn-secondary"
                disabled={upload.uploading}
                id={upload.id}
                title={upload.title}
              >
                <Upload className="w-4 h-4" />
                {upload.uploading ? 'Uploading…' : (upload.label || 'Upload YAML')}
              </button>
            </>
          )}
          {actions}
        </div>
      </div>

      <div className={`grid ${statsCols} gap-4`}>
        {stats.map(stat => (
          <div key={stat.label} className="glass-card p-4">
            <p className="text-xs text-surface-450 uppercase tracking-wider">{stat.label}</p>
            <p className={`text-2xl font-bold mt-1 ${stat.color}`}>{stat.value}</p>
          </div>
        ))}
      </div>

      <div className="relative">
        <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-surface-450" />
        <input type="text" id={searchId} aria-label={searchPlaceholder} placeholder={searchPlaceholder} value={search} onChange={(e) => onSearch(e.target.value)} className="input pl-11" />
      </div>

      {error && (
        <div className="glass-card p-6 border-red-500/30 bg-red-500/5 text-center">
          <p className="text-red-400 text-sm">{error}</p>
          {errorHint}
        </div>
      )}

      {!error && (
        <div className="glass-card overflow-hidden">
          <table className="w-full" id={tableId}>
            <thead>
              <tr className="border-b border-surface-700/50">
                {columns.map((col, i) => (
                  <th
                    key={i}
                    className={col.thClassName || (col.label
                      ? 'text-left py-3.5 px-5 text-xs font-semibold text-surface-400 uppercase tracking-wider'
                      : 'w-24')}
                  >
                    {col.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading && initialLoad ? (
                <tr><td colSpan={colSpan} className="text-center py-12 text-surface-450">
                  <div className="flex flex-col items-center gap-3">
                    <div className="w-8 h-8 border-2 border-dfaas-500/30 border-t-dfaas-500 rounded-full animate-spin" />
                    <span className="text-sm">{loadingText}</span>
                  </div>
                </td></tr>
              ) : items.length === 0 ? (
                <tr><td colSpan={colSpan} className="text-center py-12 text-surface-450">
                  {EmptyIcon && <EmptyIcon className="w-10 h-10 mx-auto mb-3 opacity-30" />}
                  <p className="text-sm">{emptyText}</p>
                </td></tr>
              ) : items.map((item, i) => renderRow(item, i))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
