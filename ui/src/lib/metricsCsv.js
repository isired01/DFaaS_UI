// CSV import for the metrics-export table. The file is ';'-delimited with the
// columns: type ; query ; metric_name ; comment. `type` is "metric" (a bare
// PromQL metric -> app type "raw") or "query" (a PromQL expression -> app type
// "custom-promql"). Comma can't be the delimiter because PromQL queries contain
// commas. A value that itself contains ';' (e.g. foo{bar=~"a;b"}) must be
// double-quoted, RFC4180 style — an unquoted extra ';' shifts every later column
// and is rejected rather than silently imported.
const TYPE_MAP = { metric: 'raw', query: 'custom-promql' };

const EXPECTED_FIELDS = 4;

// splitCsvLine splits one line on ';', honouring double-quoted fields: inside
// quotes the delimiter is literal and '""' is an escaped quote. A quote only
// opens a field at its start, so PromQL label matchers (job="x") stay valid
// unquoted. Returns null on an unterminated quote so the caller can report it.
function splitCsvLine(raw) {
  const fields = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (quoted) {
      if (ch === '"') {
        if (raw[i + 1] === '"') { cur += '"'; i++; continue; }
        quoted = false;
        continue;
      }
      cur += ch;
      continue;
    }
    if (ch === '"' && cur.trim() === '') { quoted = true; cur = ''; continue; }
    if (ch === ';') { fields.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (quoted) return null;
  fields.push(cur);
  return fields;
}

// parseMetricsCsv(text) -> { metrics, errors }. Strict + position-based (column
// header names are ignored). The caller rejects the whole file when `errors` is
// non-empty.
export function parseMetricsCsv(text) {
  const errors = [];
  const metrics = [];
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  let headerSkipped = false;

  lines.forEach((raw, idx) => {
    if (!raw.trim()) return; // blank line
    const lineNo = idx + 1;
    const parts = splitCsvLine(raw);
    if (!parts) {
      errors.push(`Line ${lineNo}: unterminated double quote`);
      return;
    }
    const type = (parts[0] || '').trim().toLowerCase();
    if (!headerSkipped && type === 'type') { headerSkipped = true; return; } // header row
    headerSkipped = true;

    if (parts.length > EXPECTED_FIELDS) {
      errors.push(`Line ${lineNo}: ${parts.length} ';'-separated fields, expected ${EXPECTED_FIELDS} (type;query;metric_name;comment) — wrap any value containing ';' in double quotes`);
      return;
    }
    const query = (parts[1] || '').trim();
    const metricName = (parts[2] || '').trim();
    const comment = (parts[3] || '').trim();
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
