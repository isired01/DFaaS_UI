// Draft → CreateLoadTest payload. Pure: returns { payload, errors } and never
// throws, so the page only decides how to show the first error and every rule
// below is table-testable without rendering a form. Before this, handleSubmit
// in LoadTestNew.jsx was 138 lines with 21 throw sites, reachable only by
// driving the UI.
import { generateK6Script } from '../k6Generator.js';
import { formatGoDuration } from '../duration.js';
import { perNodeTotalMs, validateScenarios } from '../scenarios.js';

export const SOURCE_GENERATE = 'generate';
export const SOURCE_RAW = 'raw';

/**
 * @param draft { namespace, envName, metrics, perNode, step, nameSuffix,
 *                syncStart, submitMode, startAt, now }
 * @param rules the gateway's loadTest rules (GET /api/meta/schema).loadTest
 */
export function buildLoadTestPayload(draft, rules) {
  const errors = [];
  const warnings = [];
  const now = draft.now ?? Date.now();

  const cleanMetrics = (draft.metrics || [])
    .map((m) => ({
      type: m.type,
      metricName: (m.metricName || '').trim(),
      query: (m.query || '').trim(),
      comment: (m.comment || '').trim(),
    }))
    .filter((m) => m.query || m.metricName);
  if (cleanMetrics.length === 0) errors.push('At least one metric row is required');
  cleanMetrics.forEach((m, i) => {
    if (!rules.metricTypes.some((t) => t.value === m.type)) errors.push(`metrics[${i}]: invalid type`);
    if (!m.query) errors.push(`metrics[${i}]: query is required`);
    if (m.type === 'custom-promql' && !m.metricName) errors.push(`metrics[${i}]: metric name is required for 'Custom PromQL query'`);
  });
  const nameCounts = {};
  for (const m of cleanMetrics) if (m.metricName) nameCounts[m.metricName] = (nameCounts[m.metricName] || 0) + 1;
  const dupes = Object.keys(nameCounts).filter((n) => nameCounts[n] > 1);
  if (dupes.length > 0) warnings.push(`duplicate metricName(s): ${dupes.join(', ')}`); // warn-only per contract

  const goDuration = new RegExp(rules.goDurationPattern);
  const perNodeLoad = [];
  for (const [nodeID, d] of Object.entries(draft.perNode || {})) {
    if (!d.enabled) continue;
    if (!d.vus || d.vus < rules.minVUs) errors.push(`Node '${nodeID}' needs vus >= ${rules.minVUs}`);

    // Duration is derived for generated scripts and typed only for raw ones.
    // k6 never reads the CRD field; its job is to be truthful enough to drive
    // the progress bar.
    let duration = '';
    let script = '';
    if (d.source === SOURCE_RAW) {
      if (!d.duration) errors.push(`Node '${nodeID}' needs a duration`);
      else if (!goDuration.test(d.duration)) errors.push(`Node '${nodeID}': duration must be a Go duration like '30s', '5m' or '1h30m' (got '${d.duration}')`);
      duration = d.duration;
      script = d.rawScript || '';
      if (!script.trim()) errors.push(`Node '${nodeID}' has no raw script`);
    } else {
      const scenErrs = validateScenarios(d.scenarios, `Node '${nodeID}'`);
      errors.push(...scenErrs);
      // Stage durations get their only validation here: they live inside the
      // generated script, so neither the CRD nor the API server can check them.
      const totalMs = perNodeTotalMs(d.scenarios);
      if (scenErrs.length === 0 && (totalMs === null || totalMs <= 0)) {
        errors.push(`Node '${nodeID}': cannot compute the run length — every scenario needs a valid startTime and durations like '30s' or '1m30s'`);
      }
      if (scenErrs.length === 0 && totalMs > 0) {
        duration = formatGoDuration(totalMs);
        script = generateK6Script(d.scenarios);
      }
    }
    perNodeLoad.push({ nodeID, vus: parseInt(d.vus) || 1, duration, script });
  }
  if (perNodeLoad.length === 0) errors.push('Enable at least one k6 node and configure its load');

  const payload = {
    namespace: draft.namespace,
    targetEnvironment: draft.envName,
    perNodeLoad,
    metricsExport: {
      metrics: cleanMetrics.map((m) => {
        const out = { type: m.type, query: m.query };
        if (m.metricName) out.metricName = m.metricName;
        if (m.comment) out.comment = m.comment;
        return out;
      }),
      step: draft.step || '15s',
    },
    syncStart: !!draft.syncStart,
    suspended: true,
  };
  if ((draft.nameSuffix || '').trim()) payload.nameSuffix = draft.nameSuffix.trim();

  if (draft.submitMode === 'schedule') {
    if (!draft.startAt) errors.push('Pick a start time or switch to Save as Draft');
    else {
      const t = new Date(draft.startAt);
      if (isNaN(t.getTime())) errors.push('startAt is not a valid timestamp');
      else if (t.getTime() < now) errors.push('startAt must be in the future');
      else payload.startAt = t.toISOString();
    }
  }

  return { payload, errors, warnings };
}
