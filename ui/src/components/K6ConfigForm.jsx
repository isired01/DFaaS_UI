import { useState, useEffect } from 'react';
import { Wand2, Download, Copy, Check, Globe, Plus, Trash2, ChevronDown, ChevronUp, Play, Clock } from 'lucide-react';
import { generateK6, launchK6 } from '../api/client';

const DEFAULT_STAGE = { duration: '10s', target: 10 };
const DEFAULT_SCENARIO = {
  name: 'scenario_1',
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

export default function K6ConfigForm({ experiment, isReady }) {
  // Calcolo URL target disponibili
  const availableUrls = [];
  if (experiment?.federation?.nodes) {
    experiment.federation.nodes.forEach(node => {
      if (node.functions) {
        node.functions.forEach(fn => {
          availableUrls.push({
            url: `http://${node.ipAddress}:30080/function/${fn.name}`,
            label: `${node.nodeID} — ${fn.name}`,
          });
        });
      }
    });
  }

  const storageKeyScenarios = `dfaas_k6_scenarios_${experiment?.namespace}_${experiment?.name}`;
  const storageKeyMetrics = `dfaas_k6_metrics_${experiment?.namespace}_${experiment?.name}`;

  const [scenarios, setScenarios] = useState(() => {
    const saved = localStorage.getItem(storageKeyScenarios);
    if (saved) {
      try { return JSON.parse(saved); } catch (e) { /* fallback */ }
    }
    return [{ ...DEFAULT_SCENARIO }];
  });
  
  const [metricsQueries, setMetricsQueries] = useState(() => {
    return localStorage.getItem(storageKeyMetrics) || "";
  });

  // Effetto per ricaricare i dati se cambia l'esperimento (es. navigazione tra dettagli)
  useEffect(() => {
    const savedScen = localStorage.getItem(storageKeyScenarios);
    if (savedScen) {
      try { setScenarios(JSON.parse(savedScen)); } catch (e) { setScenarios([{ ...DEFAULT_SCENARIO }]); }
    } else {
      setScenarios([{ ...DEFAULT_SCENARIO }]);
    }

    const savedMetrics = localStorage.getItem(storageKeyMetrics);
    setMetricsQueries(savedMetrics || "");
    
    // Resetta il risultato del test precedente quando cambi pagina
    setResult(null);
    setError(null);
  }, [experiment?.namespace, experiment?.name]);

  // Salva i dati automaticamente quando cambiano
  useEffect(() => {
    localStorage.setItem(storageKeyScenarios, JSON.stringify(scenarios));
  }, [scenarios, storageKeyScenarios]);

  useEffect(() => {
    localStorage.setItem(storageKeyMetrics, metricsQueries);
  }, [metricsQueries, storageKeyMetrics]);
  const [expandedScenarios, setExpandedScenarios] = useState([0]);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);
  const [cooldown, setCooldown] = useState(false);

  const toggleExpand = (index) => {
    if (expandedScenarios.includes(index)) {
      setExpandedScenarios(expandedScenarios.filter((i) => i !== index));
    } else {
      setExpandedScenarios([...expandedScenarios, index]);
    }
  };

  const addScenario = () => {
    const newScen = { ...DEFAULT_SCENARIO, name: `scenario_${scenarios.length + 1}` };
    setScenarios([...scenarios, newScen]);
    setExpandedScenarios([...expandedScenarios, scenarios.length]);
  };

  const removeScenario = (index) => {
    setScenarios(scenarios.filter((_, i) => i !== index));
  };

  const updateScenario = (index, field, value) => {
    const updated = [...scenarios];
    updated[index][field] = value;
    setScenarios(updated);
  };

  const addStage = (scenIndex) => {
    const updated = [...scenarios];
    updated[scenIndex].stages.push({ ...DEFAULT_STAGE });
    setScenarios(updated);
  };

  const removeStage = (scenIndex, stageIndex) => {
    const updated = [...scenarios];
    updated[scenIndex].stages = updated[scenIndex].stages.filter((_, i) => i !== stageIndex);
    setScenarios(updated);
  };

  const updateStage = (scenIndex, stageIndex, field, value) => {
    const updated = [...scenarios];
    let parsedValue = value;
    if (field === 'target') {
      parsedValue = parseInt(value) || 0;
    }
    updated[scenIndex].stages[stageIndex][field] = parsedValue;
    setScenarios(updated);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      // Validazione basica
      for (const s of scenarios) {
        if (!s.name || !s.targetURL) throw new Error("Nome e Target URL sono obbligatori per tutti gli scenari.");
        if (s.headers) {
          try { JSON.parse(s.headers); }
          catch { throw new Error(`Headers non validi nello scenario ${s.name} (deve essere JSON valido)`); }
        }
      }
      
      const parsedScenarios = scenarios.map(s => ({
        ...s,
        preAllocatedVUs: parseInt(s.preAllocatedVUs) || 0,
        maxVUs: parseInt(s.maxVUs) || 0,
      }));

      // Lancio diretto
      const data = await launchK6(experiment.namespace, experiment.name, parsedScenarios, metricsQueries);
      setResult(data);
      setCooldown(true);
      setTimeout(() => setCooldown(false), 30000);
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  };

  const handleCopy = async (text) => { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); };
  const handleDownload = (content, filename) => { const b = new Blob([content], { type: 'text/yaml' }); const u = URL.createObjectURL(b); const a = document.createElement('a'); a.href = u; a.download = filename; a.click(); URL.revokeObjectURL(u); };

  return (
    <div className="space-y-6">
      <form onSubmit={handleSubmit} className="space-y-5">
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-surface-300">Scenari k6</h3>
            <button type="button" onClick={addScenario} className="btn-secondary text-xs px-3 py-1.5">
              <Plus className="w-3.5 h-3.5" /> Aggiungi Scenario
            </button>
          </div>
          
          <div className="p-4 border border-dfaas-500/30 bg-dfaas-500/5 rounded-xl">
            <label className="block text-xs font-semibold text-dfaas-300 mb-1">Custom Metrics Queries (Opzionale)</label>
            <p className="text-[10px] text-surface-400 mb-2">
              Se specifichi delle query separate da pipe (<code>|</code>), l'operatore sovrascriverà quelle di default. Es: <code>k6_http_req_duration_gauge|node_cpu_seconds_total</code>
            </p>
            <input 
              type="text" 
              className="input py-2 text-sm" 
              placeholder="Lascia vuoto per usare quelle di default..." 
              value={metricsQueries} 
              onChange={(e) => setMetricsQueries(e.target.value)} 
            />
          </div>
        </div>

        <div className="space-y-4">
          {scenarios.map((scen, sIdx) => {
            const isExpanded = expandedScenarios.includes(sIdx);
            return (
              <div key={sIdx} className="border border-surface-700/50 rounded-xl overflow-hidden bg-surface-900/50">
                {/* Header Scenario */}
                <div 
                  className="flex items-center justify-between p-4 cursor-pointer hover:bg-surface-800/50 transition-colors"
                  onClick={() => toggleExpand(sIdx)}
                >
                  <div className="flex items-center gap-3">
                    {isExpanded ? <ChevronUp className="w-4 h-4 text-surface-400" /> : <ChevronDown className="w-4 h-4 text-surface-400" />}
                    <span className="font-semibold text-white">{scen.name || `Scenario ${sIdx + 1}`}</span>
                    <span className="text-xs text-surface-500 font-mono px-2 py-0.5 bg-surface-800 rounded-md">
                      {scen.method} {scen.targetURL ? new URL(scen.targetURL).pathname : '...'}
                    </span>
                  </div>
                  <button 
                    type="button" 
                    onClick={(e) => { e.stopPropagation(); removeScenario(sIdx); }} 
                    disabled={scenarios.length === 1}
                    className="p-1.5 text-surface-500 hover:text-red-400 disabled:opacity-30 transition-colors"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>

                {/* Body Scenario */}
                {isExpanded && (
                  <div className="p-4 border-t border-surface-700/50 space-y-4 bg-surface-950/30">
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      {/* Name */}
                      <div>
                        <label className="block text-xs font-medium text-surface-400 mb-1">Nome Scenario</label>
                        <input type="text" className="input py-2 text-sm" value={scen.name} onChange={(e) => updateScenario(sIdx, 'name', e.target.value)} required />
                      </div>
                      {/* Executor */}
                      <div>
                        <label className="block text-xs font-medium text-surface-400 mb-1">Executor k6</label>
                        <select className="input py-2 text-sm" value={scen.executor || 'ramping-arrival-rate'} onChange={(e) => updateScenario(sIdx, 'executor', e.target.value)}>
                          <option value="shared-iterations">Shared iterations</option>
                          <option value="per-vu-iterations">Per VU iterations</option>
                          <option value="constant-vus">Constant VUs</option>
                          <option value="ramping-vus">Ramping VUs</option>
                          <option value="constant-arrival-rate">Constant Arrival Rate</option>
                          <option value="ramping-arrival-rate">Ramping Arrival Rate</option>
                        </select>
                      </div>
                      {/* Start Time */}
                      <div>
                        <label className="block text-xs font-medium text-surface-400 mb-1">Start Time (es. 0s, 30s)</label>
                        <input type="text" className="input py-2 text-sm" value={scen.startTime} onChange={(e) => updateScenario(sIdx, 'startTime', e.target.value)} required />
                      </div>
                    </div>

                    {/* Method & URL */}
                    <div>
                      <label className="block text-xs font-medium text-surface-400 mb-1">Method & Target URL</label>
                      <div className="flex gap-2">
                        <select className="input py-2 text-sm w-24" value={scen.method} onChange={(e) => updateScenario(sIdx, 'method', e.target.value)}>
                          <option>GET</option>
                          <option>POST</option>
                          <option>PUT</option>
                          <option>DELETE</option>
                        </select>
                        {/* URL Combo */}
                        <div className="relative flex-1 flex flex-col gap-2">
                          {availableUrls.length > 0 && (
                            <select 
                              className="input py-2 text-sm" 
                              value={scen.targetURL} 
                              onChange={(e) => updateScenario(sIdx, 'targetURL', e.target.value)}
                            >
                              <option value="">-- Seleziona o scrivi custom --</option>
                              {availableUrls.map((au, i) => (
                                <option key={i} value={au.url}>{au.label} ({au.url})</option>
                              ))}
                            </select>
                          )}
                          <input 
                            type="url" 
                            className="input py-2 text-sm" 
                            placeholder="http://192.168...:30080/function/..." 
                            value={scen.targetURL} 
                            onChange={(e) => updateScenario(sIdx, 'targetURL', e.target.value)} 
                            required 
                          />
                        </div>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {/* PreAllocated VUs */}
                      <div>
                        <label className="block text-xs font-medium text-surface-400 mb-1">PreAllocated VUs</label>
                        <input type="number" min="1" className="input py-2 text-sm" value={scen.preAllocatedVUs} onChange={(e) => updateScenario(sIdx, 'preAllocatedVUs', e.target.value)} required />
                      </div>
                      {/* Max VUs */}
                      <div>
                        <label className="block text-xs font-medium text-surface-400 mb-1">Max VUs</label>
                        <input type="number" min="1" className="input py-2 text-sm" value={scen.maxVUs} onChange={(e) => updateScenario(sIdx, 'maxVUs', e.target.value)} required />
                      </div>
                    </div>

                    {/* Headers & Body */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-xs font-medium text-surface-400 mb-1">Headers (JSON)</label>
                        <textarea className="input py-2 text-xs font-mono h-24" value={scen.headers} onChange={(e) => updateScenario(sIdx, 'headers', e.target.value)} />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-surface-400 mb-1">Body / Payload</label>
                        <textarea className="input py-2 text-xs font-mono h-24" value={scen.body} onChange={(e) => updateScenario(sIdx, 'body', e.target.value)} />
                      </div>
                    </div>

                    {/* Stages */}
                    <div>
                      <div className="flex items-center justify-between mb-2 mt-2">
                        <label className="block text-xs font-medium text-surface-400">Stages (Arrival Rate)</label>
                        <button type="button" onClick={() => addStage(sIdx)} className="text-[10px] text-dfaas-400 hover:text-dfaas-300 font-medium">
                          + Aggiungi Stage
                        </button>
                      </div>
                      <div className="space-y-2">
                        {scen.stages.map((stage, stIdx) => (
                          <div key={stIdx} className="flex items-center gap-2">
                            <input type="text" placeholder="Duration (es. 10s)" className="input py-1.5 text-xs flex-1" value={stage.duration} onChange={(e) => updateStage(sIdx, stIdx, 'duration', e.target.value)} required />
                            <input type="number" placeholder="Target RPS" className="input py-1.5 text-xs flex-1" value={stage.target} onChange={(e) => updateStage(sIdx, stIdx, 'target', e.target.value)} required />
                            <button type="button" onClick={() => removeStage(sIdx, stIdx)} disabled={scen.stages.length === 1} className="p-1.5 text-surface-500 hover:text-red-400 disabled:opacity-30">
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>

                  </div>
                )}
              </div>
            );
          })}
        </div>

        {error && <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-sm">{error}</div>}
        
        <button type="submit" className="btn-primary w-full justify-center" disabled={!isReady || loading || cooldown}>
          {loading ? <><div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />Launching...</> : 
           cooldown ? <><Clock className="w-4 h-4 animate-pulse" />Attendere 30s...</> : 
           <><Play className="w-4 h-4" />Launch Load Test</>}
        </button>
      </form>

      {result && (
        <div className="space-y-4 animate-slide-up mt-8">
          <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 flex items-center gap-3">
            <Check className="w-5 h-5 flex-shrink-0" />
            <div>
              <p className="font-semibold text-sm">Test lanciato con successo!</p>
              <p className="text-xs opacity-80 mt-0.5">{result.message}</p>
            </div>
          </div>
          <div>
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-sm font-semibold text-surface-300">k6 Script Multi-Scenario</h4>
              <button onClick={() => handleCopy(result.script)} className="btn-secondary text-xs px-3 py-1.5">
                {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}{copied ? 'Copied!' : 'Copy'}
              </button>
            </div>
            <pre className="code-block max-h-64 overflow-y-auto">{result.script}</pre>
          </div>
          <div>
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-sm font-semibold text-surface-300">TestRun YAML</h4>
              <button onClick={() => handleDownload(result.yaml, 'k6-testrun.yaml')} className="btn-primary text-xs px-3 py-1.5">
                <Download className="w-3.5 h-3.5" />Download
              </button>
            </div>
            <pre className="code-block max-h-80 overflow-y-auto">{result.yaml}</pre>
          </div>
        </div>
      )}
    </div>
  );
}
