import { Plus, Trash2, ChevronDown, ChevronUp, Image, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import NumberInput from './NumberInput';
import InfoTooltip from './InfoTooltip';
import { uploadLoadTestAsset } from '../api/client';

const DEFAULT_STAGE = { duration: '10s', target: 10 };

// Monotonic session counter behind both the stable scenario `id` and the default
// name. Neither may be derived from scenarios.length: remove-then-add hands out
// a name that is still in use, and the generated script keys its `scenarios`
// object BY NAME — a duplicate key silently collapses two scenarios into one
// (last write wins) and that load never runs.
let scenarioSeq = 0;

function nextSeq() {
  scenarioSeq += 1;
  return scenarioSeq;
}

// The timestamp keeps ids unique across a page reload, where the counter
// restarts at 0 while older ids live on in the localStorage draft.
function scenarioId(seq) {
  return `scn-${seq}-${Date.now().toString(36)}`;
}

// newScenario builds a blank scenario with a stable id and a default name that
// does not collide with any name already present in `existing`.
// SUPPORTED_EXECUTORS are the k6 executors renderScenario() has a branch for.
// The VU-based ones are absent on purpose: the generator does not emit their
// options (vus/iterations/maxDuration), so a script naming one fails k6's own
// validation on the remote runner, after dispatch, where the error is invisible.
// Extend this only together with renderScenario() and lib/duration.js.
export const SUPPORTED_EXECUTORS = ['ramping-arrival-rate', 'constant-arrival-rate'];
export const DEFAULT_EXECUTOR = 'ramping-arrival-rate';

export function newScenario(existing = []) {
  const taken = new Set((existing || []).map(s => s?.name));
  let seq = nextSeq();
  while (taken.has(`scenario_${seq}`)) seq = nextSeq();
  return {
    id: scenarioId(seq),
    name: `scenario_${seq}`,
    executor: DEFAULT_EXECUTOR,
    // Used only by constant-arrival-rate; carried always so switching executor
    // in the picker never lands on an undefined field.
    rate: 10,
    duration: '1m',
    method: 'GET',
    targetURL: '',
    startTime: '0s',
    preAllocatedVUs: 10,
    maxVUs: 50,
    body: '',
    headers: '{\n  "Content-Type": "application/json"\n}',
    stages: [
      { duration: '10s', target: 10 },
      { duration: '30s', target: 10 },
      { duration: '10s', target: 0 },
    ],
  };
}

// ensureScenarioIds backfills `id` on scenarios restored from a draft written
// before ids existed. Without one the editor falls back to array position and
// the per-scenario upload state follows the wrong scenario after a removal.
//
// It also rewrites any executor the generator cannot emit. Drafts saved while
// the picker still offered the VU-based executors carry a value with no
// matching <option>, which renders the select blank and would generate a script
// k6 rejects. Coercing to the default keeps an old draft usable instead of
// silently broken, and backfills the constant-arrival-rate fields so switching
// to it in the picker never reads undefined.
export function ensureScenarioIds(scenarios) {
  return (scenarios || []).map(s => {
    const out = s?.id ? { ...s } : { ...s, id: scenarioId(nextSeq()) };
    if (!SUPPORTED_EXECUTORS.includes(out.executor)) out.executor = DEFAULT_EXECUTOR;
    if (out.rate === undefined) out.rate = 10;
    if (out.duration === undefined) out.duration = '1m';
    return out;
  });
}

export default function K6ScenariosEditor({ scenarios, onChange, availableUrls = [], envNs, envName }) {
  const [expanded, setExpanded] = useState(() => (scenarios.length > 0 ? [scenarios[0].id] : []));
  // Stable scenario id → { uploading, error } for the image picker. Keyed off
  // the id, not the array index: after a removal the indices shift and the
  // spinner/error would render on the wrong scenario.
  const [uploads, setUploads] = useState({});

  // Latest scenarios, for continuations that resume after an await. The props
  // array captured before the await is stale by then, so patching on top of it
  // would silently revert any edit made while the upload was in flight.
  const scenariosRef = useRef(scenarios);
  useEffect(() => { scenariosRef.current = scenarios; }, [scenarios]);

  const toggle = (id) => setExpanded(expanded.includes(id) ? expanded.filter(x => x !== id) : [...expanded, id]);

  const addScenario = () => {
    const scen = newScenario(scenarios);
    onChange([...scenarios, scen]);
    setExpanded([...expanded, scen.id]);
  };

  const removeScenario = (id) => {
    onChange(scenarios.filter(s => s.id !== id));
    setExpanded(expanded.filter(x => x !== id));
    setUploads(prev => { const next = { ...prev }; delete next[id]; return next; });
  };

  const updateScenario = (id, patch) => {
    onChange(scenariosRef.current.map(s => (s.id === id ? { ...s, ...patch } : s)));
  };

  const addStage = (s) => updateScenario(s.id, { stages: [...(s.stages || []), { ...DEFAULT_STAGE }] });
  const removeStage = (s, stIdx) => updateScenario(s.id, { stages: (s.stages || []).filter((_, x) => x !== stIdx) });
  const updateStage = (s, stIdx, patch) => updateScenario(s.id, {
    stages: (s.stages || []).map((st, x) => x === stIdx ? { ...st, ...patch } : st),
  });

  const setUploadState = (id, patch) => setUploads(prev => ({ ...prev, [id]: { ...prev[id], ...patch } }));

  const handleImageSelect = async (id, file) => {
    if (!file) return;
    setUploadState(id, { uploading: true, error: null });
    try {
      const { url, contentType, filename } = await uploadLoadTestAsset(envNs, envName, file);
      updateScenario(id, { payloadImageURL: url, payloadContentType: contentType, payloadFilename: filename });
      setUploadState(id, { uploading: false, error: null });
    } catch (err) {
      setUploadState(id, { uploading: false, error: err.message });
    }
  };

  const removeImage = (id) => {
    updateScenario(id, { payloadImageURL: undefined, payloadContentType: undefined, payloadFilename: undefined });
    setUploadState(id, { error: null });
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold text-surface-300">Scenarios ({scenarios.length})</h3>
      </div>

      {scenarios.map((scen, sIdx) => {
        const isExpanded = expanded.includes(scen.id);
        return (
          <div key={scen.id} className="border border-surface-700/50 rounded-xl overflow-hidden bg-surface-900/50">
            <div className="flex items-center justify-between p-3 cursor-pointer hover:bg-surface-800/50 transition-colors" onClick={() => toggle(scen.id)}>
              <div className="flex items-center gap-3">
                {isExpanded ? <ChevronUp className="w-4 h-4 text-surface-400" /> : <ChevronDown className="w-4 h-4 text-surface-400" />}
                <span className="text-sm font-semibold text-white">{scen.name || `Scenario ${sIdx + 1}`}</span>
                <span className="text-[12px] text-surface-450 font-mono px-2 py-0.5 bg-surface-800 rounded-md">
                  {scen.method} {scen.targetURL ? (() => { try { return new URL(scen.targetURL).pathname; } catch { return '...'; } })() : '...'}
                </span>
              </div>
              <button type="button" onClick={(e) => { e.stopPropagation(); removeScenario(scen.id); }} disabled={scenarios.length === 1} aria-label={`Remove scenario ${scen.name}`} title="Remove scenario" className="p-1.5 text-surface-450 hover:text-red-400 disabled:opacity-30">
                <Trash2 className="w-4 h-4" />
              </button>
            </div>

            {isExpanded && (
              <div className="p-3 border-t border-surface-700/50 space-y-3 bg-surface-950/30">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div>
                    <label htmlFor={`${scen.id}-name`} className="block text-[12px] text-surface-400 mb-1">Name</label>
                    <input type="text" id={`${scen.id}-name`} className="input py-1.5 text-xs" value={scen.name} onChange={(e) => updateScenario(scen.id, { name: e.target.value })} required />
                  </div>
                  <div>
                    <label htmlFor={`${scen.id}-executor`} className="flex items-center gap-1 text-[12px] text-surface-400 mb-1">
                      Executor
                      <InfoTooltip text="k6 execution model, open both ways: the target is a request rate, not a VU count. Ramping varies that rate across the stages below; Constant holds it flat for a fixed duration. The VU-based executors (constant-vus, ramping-vus, shared-iterations, per-vu-iterations) are not offered because the generator does not emit their options — use 'Paste raw JS' for those." />
                    </label>
                    <select id={`${scen.id}-executor`} className="input py-1.5 text-xs" value={scen.executor} onChange={(e) => updateScenario(scen.id, { executor: e.target.value })}>
                      {/* Only executors renderScenario() has a branch for. Adding one here without
                          its branch there — and its case in lib/duration.js — emits a script the
                          remote runner rejects, and the failure surfaces only after dispatch. */}
                      <option value="ramping-arrival-rate">Ramping Arrival Rate</option>
                      <option value="constant-arrival-rate">Constant Arrival Rate</option>
                    </select>
                    <p className="mt-1 text-[11px] text-surface-450">
                      VU-based executors are not generated. Use{' '}
                      <span className="font-medium">Paste raw JS</span> for those.
                    </p>
                  </div>
                  <div>
                    <label htmlFor={`${scen.id}-startTime`} className="block text-[12px] text-surface-400 mb-1">Start Time</label>
                    <input type="text" id={`${scen.id}-startTime`} className="input py-1.5 text-xs" value={scen.startTime} onChange={(e) => updateScenario(scen.id, { startTime: e.target.value })} required />
                  </div>
                </div>

                <div>
                  <label htmlFor={`${scen.id}-method`} className="block text-[12px] text-surface-400 mb-1">Method & Target URL</label>
                  <div className="flex gap-2">
                    <select id={`${scen.id}-method`} aria-label="HTTP method" className="input py-1.5 text-xs w-24" value={scen.method} onChange={(e) => updateScenario(scen.id, { method: e.target.value })}>
                      <option>GET</option><option>POST</option><option>PUT</option><option>DELETE</option>
                    </select>
                    <div className="flex-1 flex flex-col gap-1.5">
                      {availableUrls.length > 0 && (
                        <select aria-label="Target URL preset" className="input py-1.5 text-xs" value={scen.targetURL} onChange={(e) => updateScenario(scen.id, { targetURL: e.target.value })}>
                          <option value="">-- Select or type below --</option>
                          {availableUrls.map((au, i) => <option key={i} value={au.url}>{au.label} ({au.url})</option>)}
                        </select>
                      )}
                      <input type="url" aria-label="Target URL" className="input py-1.5 text-xs" placeholder="http://..." value={scen.targetURL} onChange={(e) => updateScenario(scen.id, { targetURL: e.target.value })} required />
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label htmlFor={`${scen.id}-preAllocatedVUs`} className="flex items-center gap-1 text-[12px] text-surface-400 mb-1">
                      PreAllocated VUs
                      <InfoTooltip text="Virtual users k6 spins up before the test starts. For arrival-rate executors these serve the request rate — too few and k6 can't reach the target." />
                    </label>
                    <NumberInput id={`${scen.id}-preAllocatedVUs`} className="input py-1.5 text-xs" value={scen.preAllocatedVUs} onChange={(v) => updateScenario(scen.id, { preAllocatedVUs: v })} required />
                  </div>
                  <div>
                    <label htmlFor={`${scen.id}-maxVUs`} className="flex items-center gap-1 text-[12px] text-surface-400 mb-1">
                      Max VUs
                      <InfoTooltip text="Upper bound on VUs k6 may allocate if the pre-allocated pool can't sustain the target rate." />
                    </label>
                    <NumberInput id={`${scen.id}-maxVUs`} className="input py-1.5 text-xs" value={scen.maxVUs} onChange={(v) => updateScenario(scen.id, { maxVUs: v })} required />
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label htmlFor={`${scen.id}-headers`} className="block text-[12px] text-surface-400 mb-1">Headers (JSON)</label>
                    <textarea id={`${scen.id}-headers`} className="input py-1.5 text-[13px] font-mono h-20" value={scen.headers} onChange={(e) => updateScenario(scen.id, { headers: e.target.value })} />
                  </div>
                  <div>
                    <label htmlFor={`${scen.id}-body`} className="flex items-center gap-1 text-[12px] text-surface-400 mb-1">
                      Body / Payload
                      <InfoTooltip text="Free-text request body. Attach an image/file below to send binary bytes instead — the attachment then becomes the body and this field is disabled." />
                    </label>
                    {scen.payloadImageURL ? (
                      <div className="flex items-center gap-2 p-2 h-20 rounded-lg border border-surface-700/50 bg-surface-900/50">
                        <Image className="w-4 h-4 text-dfaas-400 flex-shrink-0" />
                        <div className="min-w-0 flex-1">
                          <p className="text-[13px] text-white truncate">{scen.payloadFilename || 'attachment'}</p>
                          <p className="text-[12px] text-surface-450 font-mono truncate">{scen.payloadContentType}</p>
                        </div>
                        <button
                          type="button"
                          onClick={() => removeImage(scen.id)}
                          title="Remove attachment"
                          aria-label="Remove attachment"
                          className="p-1 rounded-md text-surface-400 hover:text-red-400 hover:bg-surface-800/60"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ) : (
                      <textarea id={`${scen.id}-body`} className="input py-1.5 text-[13px] font-mono h-20" value={scen.body} onChange={(e) => updateScenario(scen.id, { body: e.target.value })} />
                    )}
                    <div className="mt-1.5 flex items-center gap-2">
                      <label
                        htmlFor={`img-${scen.id}`}
                        className={`btn-secondary text-[12px] px-2.5 py-1 cursor-pointer ${uploads[scen.id]?.uploading ? 'opacity-50 pointer-events-none' : ''}`}
                      >
                        {uploads[scen.id]?.uploading
                          ? <><span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />Uploading…</>
                          : <><Image className="w-3.5 h-3.5" />{scen.payloadImageURL ? 'Replace attachment' : 'Attach image / file'}</>}
                      </label>
                      <input
                        id={`img-${scen.id}`}
                        type="file"
                        accept="image/*,*/*"
                        className="hidden"
                        onChange={(e) => { const f = e.target.files[0]; e.target.value = ''; handleImageSelect(scen.id, f); }}
                      />
                    </div>
                    {uploads[scen.id]?.error && (
                      <p className="mt-1 text-[12px] text-red-400">{uploads[scen.id].error}</p>
                    )}
                  </div>
                </div>

                {scen.executor === 'constant-arrival-rate' ? (
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label htmlFor={`${scen.id}-rate`} className="flex items-center gap-1 text-[12px] text-surface-400 mb-1">
                        Rate (req/s)
                        <InfoTooltip text="Requests per second k6 holds for the whole duration. Constant, not ramped — if the pre-allocated VUs cannot sustain it, k6 reports dropped iterations rather than slowing down." />
                      </label>
                      <NumberInput id={`${scen.id}-rate`} className="input py-1.5 text-xs" value={scen.rate ?? 10} onChange={(v) => updateScenario(scen.id, { rate: v })} required />
                    </div>
                    <div>
                      <label htmlFor={`${scen.id}-duration`} className="flex items-center gap-1 text-[12px] text-surface-400 mb-1">
                        Duration
                        <InfoTooltip text="How long this scenario holds its rate, as a Go duration (e.g. 30s, 5m, 1h30m). Together with Start Time it also drives the progress bar." />
                      </label>
                      <input type="text" id={`${scen.id}-duration`} placeholder="1m" className="input py-1.5 text-xs" value={scen.duration ?? '1m'} onChange={(e) => updateScenario(scen.id, { duration: e.target.value })} required />
                    </div>
                  </div>
                ) : (
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <span className="flex items-center gap-1 text-[12px] text-surface-400">
                      Stages
                      <InfoTooltip text="Each stage ramps toward 'target' requests/sec over its 'duration' (e.g. 30s), in order. A final stage with target 0 ramps down." />
                    </span>
                  </div>
                  <div className="space-y-1.5">
                    {(scen.stages || []).map((stage, stIdx) => (
                      <div key={stIdx} className="flex items-center gap-2">
                        <input type="text" placeholder="Duration" aria-label={`Stage ${stIdx + 1} duration`} className="input py-1 text-xs flex-1" value={stage.duration} onChange={(e) => updateStage(scen, stIdx, { duration: e.target.value })} required />
                        <NumberInput placeholder="Target" aria-label={`Stage ${stIdx + 1} target rate`} className="input py-1 text-xs flex-1" value={stage.target} onChange={(v) => updateStage(scen, stIdx, { target: v })} required />
                        <button type="button" onClick={() => removeStage(scen, stIdx)} disabled={(scen.stages || []).length === 1} aria-label={`Remove stage ${stIdx + 1}`} title="Remove stage" className="p-1.5 text-surface-450 hover:text-red-400 disabled:opacity-30">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                  <div className="mt-2 flex justify-end">
                    <button type="button" onClick={() => addStage(scen)} className="text-[12px] text-dfaas-400 hover:text-dfaas-300 font-medium">+ Add Stage</button>
                  </div>
                </div>
                )}
              </div>
            )}
          </div>
        );
      })}
      <div className="flex justify-end">
        <button type="button" onClick={addScenario} className="btn-secondary text-xs px-3 py-1.5">
          <Plus className="w-3.5 h-3.5" />Add Scenario
        </button>
      </div>
    </div>
  );
}
