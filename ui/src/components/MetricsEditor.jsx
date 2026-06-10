import { Plus, Trash2, BarChart3 } from 'lucide-react';

// Metric `type` values are protocol enums sent to the operator — do not translate.
export const METRIC_TYPES = [
  { value: 'raw',           label: 'Raw metric' },
  { value: 'custom-promql', label: 'Custom PromQL query' },
];

export function emptyMetric() {
  return { type: 'custom-promql', metricName: '', query: '', comment: '' };
}

export const DEFAULT_METRICS = [
  { type: 'custom-promql', metricName: 'cpu_dfaas_pods',    query: 'sum(rate(container_cpu_usage_seconds_total{pod=~"dfaas-node-.*"}[1m])) by (pod)', comment: 'CPU rate per dFaaS pod' },
  { type: 'custom-promql', metricName: 'memory_dfaas_pods', query: 'sum(container_memory_working_set_bytes{pod=~"dfaas-node-.*"}) by (pod)',          comment: 'Working set memory per dFaaS pod' },
];

// MetricsEditor renders the metrics-export table editor plus the step input and
// inherited-destination hint. State lives in the parent (LoadTestNew).
export default function MetricsEditor({ metrics, onAdd, onRemove, onUpdate, step, onStepChange, environment }) {
  return (
    <div className="glass-card p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-surface-300 uppercase tracking-wider flex items-center gap-2">
          <BarChart3 className="w-4 h-4" />Metrics Export
        </h2>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-[10px] text-surface-500 uppercase tracking-wider">
              <th className="py-1.5 px-2 w-[18%]">Type</th>
              <th className="py-1.5 px-2 w-[22%]">Metric name</th>
              <th className="py-1.5 px-2 w-[40%]">PromQL query</th>
              <th className="py-1.5 px-2 w-[18%]">Comment</th>
              <th className="py-1.5 px-2 w-[2%]"></th>
            </tr>
          </thead>
          <tbody>
            {metrics.map((m, i) => {
              const isCustom = m.type === 'custom-promql';
              return (
                <tr key={i} className="align-top">
                  <td className="py-1 px-2">
                    <select
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
                      className="p-1.5 text-surface-500 hover:text-red-400 disabled:opacity-30"
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
        <label className="block text-xs font-medium text-surface-400 mb-1">Step</label>
        <input type="text" className="input py-2 text-sm w-32" value={step} onChange={(e) => onStepChange(e.target.value)} placeholder="15s" />
      </div>

      <div className="border-t border-surface-700/50 pt-4">
        <p className="text-xs font-medium text-surface-400 uppercase tracking-wider mb-1">Export destination</p>
        {environment?.s3ConfigRef ? (
          <p className="text-xs text-surface-400">
            Metrics export → S3 config <code className="text-dfaas-400">{environment.s3ConfigRef.name}</code> (inherited from environment).
          </p>
        ) : (
          <p className="text-xs text-surface-500">
            No S3 config on environment → metrics will be dumped to exporter pod stdout.
          </p>
        )}
      </div>
    </div>
  );
}
