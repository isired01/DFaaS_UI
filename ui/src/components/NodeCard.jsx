import { Server, Cpu, Zap, Box, Clock, Layers } from 'lucide-react';

/**
 * Colori bordo in base alla capacity del nodo.
 */
const CAPACITY_STYLES = {
  LOW:    { border: 'border-blue-500/40', bg: 'bg-blue-500/10', text: 'text-blue-400', label: 'Low' },
  MEDIUM: { border: 'border-amber-500/40', bg: 'bg-amber-500/10', text: 'text-amber-400', label: 'Medium' },
  HIGH:   { border: 'border-red-500/40', bg: 'bg-red-500/10', text: 'text-red-400', label: 'High' },
};

/**
 * Card che mostra i dettagli di un singolo nodo della federazione.
 * 
 * @param {Object} props
 * @param {Object} props.node — Dati del nodo (nodeID, ipAddress, capacity, functions, etc.)
 * @param {number} props.index — Indice per l'animazione staggered
 */
export default function NodeCard({ node, index }) {
  const capacity = CAPACITY_STYLES[node.capacity] || CAPACITY_STYLES.MEDIUM;

  return (
    <div
      className={`glass-card-hover p-5 ${capacity.border} animate-slide-up`}
      style={{ animationDelay: `${index * 80}ms` }}
      id={`node-card-${node.nodeID}`}
    >
      {/* Header */}
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
        <span className={`badge text-[10px] px-2 py-0.5 ${capacity.bg} ${capacity.text} border ${capacity.border}`}>
          {capacity.label}
        </span>
      </div>

      {/* Info Grid */}
      <div className="grid grid-cols-2 gap-3 mb-4">
        <InfoItem icon={Layers} label="Strategy" value={formatStrategy(node.balancingStrategy)} />
        <InfoItem icon={Cpu} label="Username" value={node.username} />
      </div>

      {/* Functions */}
      {node.functions && node.functions.length > 0 && (
        <div className="mt-4 pt-4 border-t border-surface-700/50">
          <h4 className="text-xs font-semibold text-surface-400 uppercase tracking-wider mb-3 flex items-center gap-1.5">
            <Zap className="w-3.5 h-3.5" />
            Functions ({node.functions.length})
          </h4>
          <div className="space-y-2">
            {node.functions.map((fn, i) => (
              <FunctionRow key={fn.name + i} fn={fn} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function InfoItem({ icon: Icon, label, value }) {
  return (
    <div className="flex items-center gap-2">
      <Icon className="w-3.5 h-3.5 text-surface-500" />
      <div>
        <p className="text-[10px] text-surface-500 uppercase">{label}</p>
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
          <p className="text-[10px] text-surface-500 font-mono truncate max-w-[200px]">{fn.image}</p>
        </div>
      </div>
      <div className="flex items-center gap-3 text-[10px] text-surface-400">
        <span className="flex items-center gap-1">
          <Clock className="w-3 h-3" />
          {fn.execTimeout}s
        </span>
        <span title="Max Inflight">
          ↕ {fn.maxInflight}
        </span>
      </div>
    </div>
  );
}

function formatStrategy(strategy) {
  const map = {
    staticstrategy: 'Static',
    nodemarginstrategy: 'Node Margin',
    recalcstrategy: 'Recalc',
    alllocalstrategy: 'All Local',
    rlagentstrategy: 'RL Agent',
  };
  return map[strategy] || strategy;
}
