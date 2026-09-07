import { useRef } from 'react';
import { Plus, Trash2, BarChart3, Upload } from 'lucide-react';
import { metricsCsvTemplate } from '../lib/metricsCsv';
import { downloadTextAsFile } from '../api/client';
import { useSchema } from '../lib/schema';

function downloadCsvTemplate() {
  downloadTextAsFile(metricsCsvTemplate(), 'metrics-template.csv', 'text/csv');
}

export function emptyMetric() {
  return { type: 'custom-promql', metricName: '', query: '', comment: '' };
}

// Two things here are load-bearing and were both wrong before; verified against
// a live cluster:
//
//   1. The pod selector is `dfaas-agent.*`. The old `dfaas-node-.*` matched ZERO
//      series, so the shipped defaults exported nothing and the exporter failed
//      the whole LoadTest on an empty CSV.
//   2. Rate windows are [5m], not [1m]. The management Prometheus does not scrape
//      the workers directly — it federates from each worker's Prometheus once a
//      minute (the chart default global.scrape_interval). A [1m] window therefore
//      holds at most one sample and rate() needs two, so every rate([1m]) query
//      silently returned no data while plain gauges kept working. Keep rate
//      windows at >= 4x the federation interval, and raise them if it is raised.
export const DEFAULT_METRICS = [
  { type: 'custom-promql', metricName: 'cpu_dfaas_pods', query: 'sum(rate(container_cpu_usage_seconds_total{pod=~"dfaas-agent.*"}[5m])) by (pod)', comment: 'CPU rate per DFaaS pod' },
  { type: 'custom-promql', metricName: 'memory_dfaas_pods', query: 'sum(container_memory_working_set_bytes{pod=~"dfaas-agent.*"}) by (pod)', comment: 'Working set memory per DFaaS pod' },
];

// MetricsEditor renders the metrics-export table editor plus the step input and
// inherited-destination hint. State lives in the parent (LoadTestNew).
export default function MetricsEditor({ metrics, onAdd, onRemove, onUpdate, onImportCsv, step, onStepChange, environment }) {
  const schema = useSchema();
  const METRIC_TYPES = schema?.loadTest.metricTypes ?? [];
  const fileInputRef = useRef(null);

  return (
    <div className="glass-card p-5 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-sm font-semibold text-surface-300 uppercase tracking-wider flex items-center gap-2">
          <BarChart3 className="w-4 h-4" />Metrics Export
        </h2>
        {onImportCsv && (
          <div className="flex flex-col items-end gap-1">
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => fileInputRef.current?.click()} className="btn-secondary text-xs px-3 py-1.5">
                <Upload className="w-3.5 h-3.5" />Import CSV
              </button>
              <input
                ref={fileInputRef}
                type="file"
                aria-label="Import metrics CSV"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(e) => { if (e.target.files[0]) onImportCsv(e.target.files[0]); e.target.value = ''; }}
              />
            </div>
            <p className="text-[12px] text-surface-450">
              Columns: <code>type(metric|query) ; query ; metric_name ; comment</code>{' · '}
              <button type="button" onClick={downloadCsvTemplate} className="text-dfaas-400 hover:text-dfaas-300 underline">example</button>
            </p>
          </div>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-[12px] text-surface-450 uppercase tracking-wider">
              <th scope="col" className="py-1.5 px-2 w-[18%]">Type</th>
              <th scope="col" className="py-1.5 px-2 w-[22%]">Metric name</th>
              <th scope="col" className="py-1.5 px-2 w-[40%]">PromQL query</th>
              <th scope="col" className="py-1.5 px-2 w-[18%]">Comment</th>
              <th scope="col" className="py-1.5 px-2 w-[2%]"></th>
            </tr>
          </thead>
          <tbody>
            {metrics.map((m, i) => {
              const isCustom = m.type === 'custom-promql';
              return (
                <tr key={i} className="align-top">
                  <td className="py-1 px-2">
                    <select
                      aria-label={`Row ${i + 1} metric type`}
                      className="input py-1.5 text-xs"
                      value={m.type}
                      onChange={(e) => onUpdate(i, { type: e.target.value })}
                    >
                      {METRIC_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                    </select>
                  </td>
                  <td className="py-1 px-2">
                    <input
                      type="text"
                      className="input py-1.5 text-xs"
                      aria-label={`Row ${i + 1} metric name`}
                      value={m.metricName}
                      onChange={(e) => onUpdate(i, { metricName: e.target.value })}
                      placeholder={isCustom ? 'required' : '(defaults to query value)'}
                      required={isCustom}
                    />
                  </td>
                  <td className="py-1 px-2">
                    <input
                      type="text"
                      className="input py-1.5 text-xs font-mono"
                      aria-label={`Row ${i + 1} query`}
                      value={m.query}
                      onChange={(e) => onUpdate(i, { query: e.target.value })}
                      placeholder={isCustom ? 'sum(rate(...))' : 'haproxy_backend_http_requests_total'}
                      required
                    />
                  </td>
                  <td className="py-1 px-2">
                    <input
                      type="text"
                      className="input py-1.5 text-xs"
                      aria-label={`Row ${i + 1} comment`}
                      value={m.comment}
                      onChange={(e) => onUpdate(i, { comment: e.target.value })}
                      placeholder="optional"
                    />
                  </td>
                  <td className="py-1 px-2">
                    <button
                      type="button"
                      onClick={() => onRemove(i)}
                      disabled={metrics.length === 1}
                      className="p-1.5 text-surface-450 hover:text-red-400 disabled:opacity-30"
                      title={metrics.length === 1 ? 'At least one metric required' : 'Remove row'}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="flex justify-end mt-2">
          <button type="button" onClick={onAdd} className="btn-secondary text-xs px-3 py-1.5">
            <Plus className="w-3.5 h-3.5" />Add row
          </button>
        </div>
      </div>

      <div>
        <label htmlFor="metrics-step" className="block text-xs font-medium text-surface-400 mb-1">Step</label>
        <input type="text" id="metrics-step" className="input py-2 text-sm w-32" value={step} onChange={(e) => onStepChange(e.target.value)} placeholder="15s" />
      </div>

      <div className="border-t border-surface-700/50 pt-4">
        <p className="text-xs font-medium text-surface-400 uppercase tracking-wider mb-1">Export destination</p>
        {environment?.s3ConfigRef ? (
          <p className="text-xs text-surface-400">
            Metrics export → S3 config <code className="text-dfaas-400">{environment.s3ConfigRef.name}</code> (inherited from environment).
          </p>
        ) : (
          <p className="text-xs text-surface-450">
            No S3 config on environment → in-cluster SeaweedFS (default).
          </p>
        )}
      </div>
    </div>
  );
}
