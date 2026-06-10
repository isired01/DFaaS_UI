import { Plus, Trash2, ChevronDown, ChevronUp } from 'lucide-react';
import { useState } from 'react';
import NumberInput from './NumberInput';
import InfoTooltip from './InfoTooltip';

const DEFAULT_STAGE = { duration: '10s', target: 10 };

export function newScenario(idx = 0) {
  return {
    name: `scenario_${idx + 1}`,
    executor: 'ramping-arrival-rate',
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

export default function K6ScenariosEditor({ scenarios, onChange, availableUrls = [] }) {
  const [expanded, setExpanded] = useState(scenarios.length > 0 ? [0] : []);

  const toggle = (i) => setExpanded(expanded.includes(i) ? expanded.filter(x => x !== i) : [...expanded, i]);

  const addScenario = () => {
    const idx = scenarios.length;
    onChange([...scenarios, newScenario(idx)]);
    setExpanded([...expanded, idx]);
  };

  const removeScenario = (i) => {
    onChange(scenarios.filter((_, idx) => idx !== i));
    setExpanded(expanded.filter(x => x !== i).map(x => x > i ? x - 1 : x));
  };

  const updateScenario = (i, patch) => {
    onChange(scenarios.map((s, idx) => idx === i ? { ...s, ...patch } : s));
  };

  const addStage = (i) => updateScenario(i, { stages: [...scenarios[i].stages, { ...DEFAULT_STAGE }] });
  const removeStage = (i, stIdx) => updateScenario(i, { stages: scenarios[i].stages.filter((_, x) => x !== stIdx) });
  const updateStage = (i, stIdx, patch) => updateScenario(i, {
    stages: scenarios[i].stages.map((st, x) => x === stIdx ? { ...st, ...patch } : st),
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-semibold text-surface-300">Scenarios ({scenarios.length})</h4>
      </div>

      {scenarios.map((scen, sIdx) => {
        const isExpanded = expanded.includes(sIdx);
        return (
          <div key={sIdx} className="border border-surface-700/50 rounded-xl overflow-hidden bg-surface-900/50">
            <div className="flex items-center justify-between p-3 cursor-pointer hover:bg-surface-800/50 transition-colors" onClick={() => toggle(sIdx)}>
              <div className="flex items-center gap-3">
                {isExpanded ? <ChevronUp className="w-4 h-4 text-surface-400" /> : <ChevronDown className="w-4 h-4 text-surface-400" />}
                <span className="text-sm font-semibold text-white">{scen.name || `Scenario ${sIdx + 1}`}</span>
                <span className="text-[10px] text-surface-500 font-mono px-2 py-0.5 bg-surface-800 rounded-md">
                  {scen.method} {scen.targetURL ? (() => { try { return new URL(scen.targetURL).pathname; } catch { return '...'; } })() : '...'}
                </span>
              </div>
              <button type="button" onClick={(e) => { e.stopPropagation(); removeScenario(sIdx); }} disabled={scenarios.length === 1} className="p-1.5 text-surface-500 hover:text-red-400 disabled:opacity-30">
                <Trash2 className="w-4 h-4" />
              </button>
            </div>

            {isExpanded && (
              <div className="p-3 border-t border-surface-700/50 space-y-3 bg-surface-950/30">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div>
                    <label className="block text-[10px] text-surface-400 mb-1">Name</label>
                    <input type="text" className="input py-1.5 text-xs" value={scen.name} onChange={(e) => updateScenario(sIdx, { name: e.target.value })} required />
                  </div>
                  <div>
                    <label className="flex items-center gap-1 text-[10px] text-surface-400 mb-1">
                      Executor
                      <InfoTooltip text="k6 execution model. Arrival-rate executors hold a target requests/sec (open model); VU executors hold a target number of virtual users (closed model). 'ramping-*' vary the target across stages; 'constant-*' hold it fixed." />
                    </label>
                    <select className="input py-1.5 text-xs" value={scen.executor} onChange={(e) => updateScenario(sIdx, { executor: e.target.value })}>
                      <option value="shared-iterations">Shared iterations</option>
                      <option value="per-vu-iterations">Per VU iterations</option>
                      <option value="constant-vus">Constant VUs</option>
                      <option value="ramping-vus">Ramping VUs</option>
                      <option value="constant-arrival-rate">Constant Arrival Rate</option>
                      <option value="ramping-arrival-rate">Ramping Arrival Rate</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] text-surface-400 mb-1">Start Time</label>
                    <input type="text" className="input py-1.5 text-xs" value={scen.startTime} onChange={(e) => updateScenario(sIdx, { startTime: e.target.value })} required />
                  </div>
                </div>

                <div>
                  <label className="block text-[10px] text-surface-400 mb-1">Method & Target URL</label>
                  <div className="flex gap-2">
                    <select className="input py-1.5 text-xs w-24" value={scen.method} onChange={(e) => updateScenario(sIdx, { method: e.target.value })}>
                      <option>GET</option><option>POST</option><option>PUT</option><option>DELETE</option>
                    </select>
                    <div className="flex-1 flex flex-col gap-1.5">
                      {availableUrls.length > 0 && (
                        <select className="input py-1.5 text-xs" value={scen.targetURL} onChange={(e) => updateScenario(sIdx, { targetURL: e.target.value })}>
                          <option value="">-- Select or type below --</option>
                          {availableUrls.map((au, i) => <option key={i} value={au.url}>{au.label} ({au.url})</option>)}
                        </select>
                      )}
                      <input type="url" className="input py-1.5 text-xs" placeholder="http://..." value={scen.targetURL} onChange={(e) => updateScenario(sIdx, { targetURL: e.target.value })} required />
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label className="flex items-center gap-1 text-[10px] text-surface-400 mb-1">
                      PreAllocated VUs
                      <InfoTooltip text="Virtual users k6 spins up before the test starts. For arrival-rate executors these serve the request rate — too few and k6 can't reach the target." />
                    </label>
                    <NumberInput className="input py-1.5 text-xs" value={scen.preAllocatedVUs} onChange={(v) => updateScenario(sIdx, { preAllocatedVUs: v })} required />
                  </div>
                  <div>
                    <label className="flex items-center gap-1 text-[10px] text-surface-400 mb-1">
                      Max VUs
                      <InfoTooltip text="Upper bound on VUs k6 may allocate if the pre-allocated pool can't sustain the target rate." />
                    </label>
                    <NumberInput className="input py-1.5 text-xs" value={scen.maxVUs} onChange={(v) => updateScenario(sIdx, { maxVUs: v })} required />
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[10px] text-surface-400 mb-1">Headers (JSON)</label>
                    <textarea className="input py-1.5 text-[11px] font-mono h-20" value={scen.headers} onChange={(e) => updateScenario(sIdx, { headers: e.target.value })} />
                  </div>
                  <div>
                    <label className="block text-[10px] text-surface-400 mb-1">Body / Payload</label>
                    <textarea className="input py-1.5 text-[11px] font-mono h-20" value={scen.body} onChange={(e) => updateScenario(sIdx, { body: e.target.value })} />
                  </div>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="flex items-center gap-1 text-[10px] text-surface-400">
                      Stages
                      <InfoTooltip text="Each stage ramps toward 'target' over its 'duration' (e.g. 30s), in order. target = requests/sec for arrival-rate executors, VU count for vus executors. A final stage with target 0 ramps down." />
                    </label>
                  </div>
                  <div className="space-y-1.5">
                    {scen.stages.map((stage, stIdx) => (
                      <div key={stIdx} className="flex items-center gap-2">
                        <input type="text" placeholder="Duration" className="input py-1 text-xs flex-1" value={stage.duration} onChange={(e) => updateStage(sIdx, stIdx, { duration: e.target.value })} required />
                        <NumberInput placeholder="Target" className="input py-1 text-xs flex-1" value={stage.target} onChange={(v) => updateStage(sIdx, stIdx, { target: v })} required />
                        <button type="button" onClick={() => removeStage(sIdx, stIdx)} disabled={scen.stages.length === 1} className="p-1.5 text-surface-500 hover:text-red-400 disabled:opacity-30">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                  <div className="mt-2 flex justify-end">
                    <button type="button" onClick={() => addStage(sIdx)} className="text-[10px] text-dfaas-400 hover:text-dfaas-300 font-medium">+ Add Stage</button>
                  </div>
                </div>
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
