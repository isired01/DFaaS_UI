import { Server, Cpu, Zap, Box, Clock, Layers, Key, Play } from 'lucide-react';
import { STRATEGY_LABELS } from '../lib/constants';

const CAPACITY_STYLES = {
  LOW: { border: 'border-blue-500/40', bg: 'bg-blue-500/10', text: 'text-blue-400', label: 'Low' },
  MEDIUM: { border: 'border-amber-500/40', bg: 'bg-amber-500/10', text: 'text-amber-400', label: 'Medium' },
  HIGH: { border: 'border-red-500/40', bg: 'bg-red-500/10', text: 'text-red-400', label: 'High' },
};

const ROLE_LABEL = {
  'dfaas-worker': 'DFaaS Worker',
  'k6-load-generator': 'k6 Generator',
};

export default function NodeCard({ node, index, variant, onConfigureLoad, configureDisabled, configureDisabledReason }) {
  const capacity = CAPACITY_STYLES[node.capacity] || CAPACITY_STYLES.MEDIUM;
  const isK6 = variant === 'k6' || node.role === 'k6-load-generator';

  return (
    <div
      className={`glass-card-hover p-5 ${capacity.border} animate-slide-up`}
      style={{ animationDelay: `${index * 80}ms` }}
      id={`node-card-${node.nodeID}`}
    >
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className={`w-10 h-10 rounded-xl ${capacity.bg} flex items-center justify-center`}>
            <Server className={`w-5 h-5 ${capacity.text}`} />
          </div>
          <div>
            <h3 className="font-semibold text-white text-sm">{node.nodeID}</h3>
            <p className="text-xs text-surface-400 font-mono">{node.ipAddress}</p>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <span className={`badge text-[12px] px-2 py-0.5 ${capacity.bg} ${capacity.text} border ${capacity.border}`}>
            {capacity.label}
          </span>
          {node.role && (
            <span className="text-[12px] text-surface-450 uppercase tracking-wider">
              {ROLE_LABEL[node.role] || node.role}
            </span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 mb-4">
        {isK6 ? (
          <InfoItem icon={Key} label="Kubeconfig Secret" value={node.kubeconfigSecret || '—'} />
        ) : (
          <InfoItem icon={Layers} label="Strategy" value={formatStrategy(node.balancingStrategy)} />
        )}
        <InfoItem icon={Cpu} label="Username" value={node.username} />
      </div>

      {!isK6 && node.functions && node.functions.length > 0 && (
        <div className="mt-4 pt-4 border-t border-surface-700/50">
          <h3 className="text-xs font-semibold text-surface-400 uppercase tracking-wider mb-3 flex items-center gap-1.5">
            <Zap className="w-3.5 h-3.5" />
            Functions ({node.functions.length})
          </h3>
          <div className="space-y-2">
            {node.functions.map((fn, i) => (
              <FunctionRow key={fn.name + i} fn={fn} />
            ))}
          </div>
        </div>
      )}

      {isK6 && onConfigureLoad && (
        <div className="mt-4 pt-4 border-t border-surface-700/50">
          <button
            type="button"
            className="btn-primary w-full justify-center text-xs py-2"
            disabled={configureDisabled}
            onClick={onConfigureLoad}
            title={configureDisabled ? configureDisabledReason : undefined}
          >
            <Play className="w-3.5 h-3.5" />
            Configure Load
          </button>
        </div>
      )}
    </div>
  );
}

function InfoItem({ icon: Icon, label, value }) {
  return (
    <div className="flex items-center gap-2">
      <Icon className="w-3.5 h-3.5 text-surface-450" />
      <div>
        <p className="text-[12px] text-surface-450 uppercase">{label}</p>
        <p className="text-xs text-surface-200 font-medium truncate">{value}</p>
      </div>
    </div>
  );
}

function FunctionRow({ fn }) {
  return (
    <div className="flex items-center justify-between p-2.5 rounded-xl bg-surface-900/50 border border-surface-700/30 group hover:border-surface-600/50 transition-colors">
      <div className="flex items-center gap-2.5">
        <Box className="w-4 h-4 text-violet-400" />
        <div>
          <p className="text-sm font-medium text-white">{fn.name}</p>
          <p className="text-[12px] text-surface-450 font-mono truncate max-w-[200px]">{fn.image}</p>
        </div>
      </div>
      <div className="flex items-center gap-3 text-[12px] text-surface-400">
        <span className="flex items-center gap-1">
          <Clock className="w-3 h-3" />
          {fn.execTimeout}s
        </span>
        <span title="Max Inflight">↕ {fn.maxInflight}</span>
      </div>
    </div>
  );
}

function formatStrategy(strategy) {
  return STRATEGY_LABELS[strategy] || strategy || '—';
}
