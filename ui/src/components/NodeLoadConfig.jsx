import { Upload, Wand2, FileCode, Server } from 'lucide-react';
import K6ScenariosEditor from './K6ScenariosEditor';
import { formatGoDuration } from '../lib/duration';
import { perNodeTotalMs } from '../lib/scenarios';

import { SOURCE_GENERATE, SOURCE_RAW } from '../lib/payloads/loadtest';
export { SOURCE_GENERATE, SOURCE_RAW };

// NodeLoadConfig renders one k6 node's load configuration: enable toggle, duration,
// the script-source switch, and either the scenarios editor or the raw-JS
// textarea. The draft state lives in the parent (LoadTestNew).
export default function NodeLoadConfig({ node, draft, onUpdate, onFile, availableUrls, envNs, envName }) {
  const update = (patch) => onUpdate(node.nodeID, patch);

  // With generated scripts the run length follows from the scenarios, so
  // duration is computed, not typed. Neither k6 nor the operator reads the CRD
  // field; it only drives the progress bar. buildLoadTestPayload recomputes the
  // same value on submit; this is its preview.
  const generated = draft.source === SOURCE_GENERATE;
  const derivedMs = generated ? perNodeTotalMs(draft.scenarios) : null;

  return (
    <div className="glass-card p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Server className="w-5 h-5 text-amber-400" />
          <div>
            <h2 className="text-sm font-semibold text-white">{node.nodeID}</h2>
            <p className="text-xs text-surface-450 font-mono">{node.ipAddress}</p>
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm text-surface-300">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => update({ enabled: e.target.checked })}
          />
          Enable
        </label>
      </div>

      {draft.enabled && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label htmlFor={`duration-${node.nodeID}`} className="block text-xs font-medium text-surface-400 mb-1">
                {generated ? 'Duration (from scenarios)' : 'Duration (e.g. 30s, 5m)'}
              </label>
              {generated ? (
                <>
                  <input
                    type="text"
                    id={`duration-${node.nodeID}`}
                    className="input py-2 text-sm opacity-60 cursor-not-allowed"
                    value={derivedMs === null ? '—' : formatGoDuration(derivedMs)}
                    readOnly
                    title="Computed from the scenarios below"
                  />
                  <p className="text-[12px] text-surface-450 mt-1">
                    {derivedMs === null
                      ? 'Fix the scenario durations below to compute this.'
                      : 'Longest scenario (startTime + its stages or duration). Drives the progress bar.'}
                  </p>
                </>
              ) : (
                <>
                  <input
                    type="text"
                    id={`duration-${node.nodeID}`}
                    className="input py-2 text-sm"
                    value={draft.duration}
                    onChange={(e) => update({ duration: e.target.value })}
                    required
                  />
                  <p className="text-[12px] text-surface-450 mt-1">
                    How long your script runs. Only used to draw the progress bar — k6 obeys the script.
                  </p>
                </>
              )}
            </div>
          </div>

          <div className="flex gap-1 p-1 bg-surface-900/50 rounded-xl w-fit">
            <button type="button" onClick={() => update({ source: SOURCE_GENERATE })} className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${draft.source === SOURCE_GENERATE ? 'bg-dfaas-600/30 text-dfaas-300 border border-dfaas-500/30' : 'text-surface-400 hover:text-white'}`}>
              <Wand2 className="w-3.5 h-3.5" />Generate from scenarios
            </button>
            <button type="button" onClick={() => update({ source: SOURCE_RAW })} className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${draft.source === SOURCE_RAW ? 'bg-dfaas-600/30 text-dfaas-300 border border-dfaas-500/30' : 'text-surface-400 hover:text-white'}`}>
              <FileCode className="w-3.5 h-3.5" />Paste raw JS
            </button>
          </div>

          {draft.source === SOURCE_GENERATE ? (
            <K6ScenariosEditor
              scenarios={draft.scenarios}
              onChange={(scenarios) => update({ scenarios })}
              availableUrls={availableUrls}
              envNs={envNs}
              envName={envName}
            />
          ) : (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <label htmlFor={`raw-file-${node.nodeID}`} className="btn-secondary text-xs px-3 py-1.5 cursor-pointer">
                  <Upload className="w-3.5 h-3.5" />Upload .js
                </label>
                <input id={`raw-file-${node.nodeID}`} type="file" accept=".js" className="hidden" onChange={(e) => e.target.files[0] && onFile(node.nodeID, e.target.files[0])} />
                <span className="text-[12px] text-surface-450">or paste below</span>
              </div>
              <textarea
                aria-label={`Raw k6 script for ${node.nodeID}`}
                className="input py-2 text-xs font-mono h-48"
                value={draft.rawScript}
                onChange={(e) => update({ rawScript: e.target.value })}
                placeholder="import http from 'k6/http';&#10;export default function() { http.get('...'); }"
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}
