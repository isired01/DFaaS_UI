// CSV import for the metrics-export table. The file is ';'-delimited with the
// columns: type ; query ; metric_name ; comment. `type` is "metric" (a bare
// PromQL metric -> app type "raw") or "query" (a PromQL expression -> app type
// "custom-promql"). Comma can't be the delimiter because PromQL queries contain
// commas.
const TYPE_MAP = { metric: 'raw', query: 'custom-promql' };

// parseMetricsCsv(text) -> { metrics, errors }. Strict + position-based (column
// header names are ignored). The caller rejects the whole file when `errors` is
// non-empty. A comment may itself contain ';' — everything after the third
// delimiter is kept as the comment.
export function parseMetricsCsv(text) {
  const errors = [];
  const metrics = [];
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  let headerSkipped = false;

  lines.forEach((raw, idx) => {
    if (!raw.trim()) return; // blank line
    const parts = raw.split(';');
    const type = (parts[0] || '').trim().toLowerCase();
    if (!headerSkipped && type === 'type') { headerSkipped = true; return; } // header row
    headerSkipped = true;

    const lineNo = idx + 1;
    const query = (parts[1] || '').trim();
    const metricName = (parts[2] || '').trim();
    const comment = parts.slice(3).join(';').trim(); // keep ';' inside comments
    const appType = TYPE_MAP[type];

    if (!appType) {
      errors.push(`Line ${lineNo}: unknown type "${(parts[0] || '').trim()}" — use "metric" or "query"`);
      return;
    }
    if (!query) {
      errors.push(`Line ${lineNo}: missing query/metric value`);
      return;
    }
    if (appType === 'custom-promql' && !metricName) {
      errors.push(`Line ${lineNo}: "query" rows need a metric_name`);
      return;
    }
    metrics.push({ type: appType, metricName, query, comment });
  });

  if (!metrics.length && !errors.length) errors.push('No metric rows found in the file.');
  return { metrics, errors };
}

// metricsCsvTemplate returns a small example file for the "example" download.
export function metricsCsvTemplate() {
  return [
    'type;query;metric_name;comment',
    'metric;node_cpu_seconds_total;;',
    'query;increase(haproxy_backend_http_responses_total[10s]);responses_total;HTTP responses over 10s',
  ].join('\n');
}
