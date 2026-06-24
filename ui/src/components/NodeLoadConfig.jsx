import { Upload, Wand2, FileCode, Server } from 'lucide-react';
import K6ScenariosEditor from './K6ScenariosEditor';
import NumberInput from './NumberInput';

export const SOURCE_GENERATE = 'generate';
export const SOURCE_RAW = 'raw';

// NodeLoadConfig renders one k6 node's load configuration: enable toggle, VUs /
// duration, the script-source switch, and either the scenarios editor or the
// raw-JS textarea. The draft state lives in the parent (LoadTestNew).
export default function NodeLoadConfig({ node, draft, onUpdate, onFile, availableUrls, envNs, envName }) {
  const update = (patch) => onUpdate(node.nodeID, patch);

  return (
    <div className="glass-card p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Server className="w-5 h-5 text-amber-400" />
          <div>
            <h2 className="text-sm font-semibold text-white">{node.nodeID}</h2>
            <p className="text-xs text-surface-500 font-mono">{node.ipAddress}</p>
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
              <label className="block text-xs font-medium text-surface-400 mb-1">VUs</label>
              <NumberInput className="input py-2 text-sm" value={draft.vus} onChange={(v) => update({ vus: v })} required />
            </div>
            <div>
              <label className="block text-xs font-medium text-surface-400 mb-1">Duration (e.g. 30s, 5m)</label>
              <input type="text" className="input py-2 text-sm" value={draft.duration} onChange={(e) => update({ duration: e.target.value })} required />
            </div>
          </div>

          <div className="flex gap-1 p-1 bg-surface-900/50 rounded-xl w-fit">
            <button type="button" onClick={() => update({ source: SOURCE_GENERATE })} className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${draft.source === SOURCE_GENERATE ? 'bg-dfaas-600/30 text-dfaas-400 border border-dfaas-500/30' : 'text-surface-400 hover:text-white'}`}>
              <Wand2 className="w-3.5 h-3.5" />Generate from scenarios
            </button>
            <button type="button" onClick={() => update({ source: SOURCE_RAW })} className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${draft.source === SOURCE_RAW ? 'bg-dfaas-600/30 text-dfaas-400 border border-dfaas-500/30' : 'text-surface-400 hover:text-white'}`}>
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
                <span className="text-[12px] text-surface-500">or paste below</span>
              </div>
              <textarea
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
