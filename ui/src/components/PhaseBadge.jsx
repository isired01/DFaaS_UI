import {
  Circle, Server, Download, Activity,
  CheckCircle, Play, Clock, Trash2,
  CheckCheck, XCircle, Loader2, LineChart
} from 'lucide-react';

/**
 * Mappa fase → { class CSS, icona Lucide, label }
 * Basata sulla state machine del controller dfaas-operator.
 */
const PHASE_CONFIG = {
  'IDLE':                        { badge: 'badge-idle',         icon: Circle,      label: 'Idle' },
  '':                            { badge: 'badge-idle',         icon: Circle,      label: 'Initializing' },
  'INFRASTRUCTURE_PROVISIONING': { badge: 'badge-provisioning', icon: Server,      label: 'Provisioning' },
  'INSTALLING_DFAAS':            { badge: 'badge-installing',   icon: Download,    label: 'Installing dFaaS' },
  'PROVISIONING_MONITORING':     { badge: 'badge-monitoring',   icon: Activity,    label: 'Monitoring Setup' },
  'READY':                       { badge: 'badge-ready',        icon: CheckCircle, label: 'Ready' },
  'RUNNING':                     { badge: 'badge-running',      icon: Play,        label: 'Running' },
  'COOLDOWN':                    { badge: 'badge-cooldown',     icon: Clock,       label: 'Cooldown' },
  'EXPORT_METRICHE':             { badge: 'badge-monitoring',   icon: LineChart,   label: 'Exporting Metrics' },
  'CLEANUP':                     { badge: 'badge-cleanup',      icon: Trash2,      label: 'Cleanup' },
  'COMPLETED':                   { badge: 'badge-completed',    icon: CheckCheck,  label: 'Completed' },
  'FAILED':                      { badge: 'badge-failed',       icon: XCircle,     label: 'Failed' },
};

/**
 * Badge che mostra la fase corrente dell'esperimento con colore e icona.
 * 
 * @param {Object} props
 * @param {string} props.phase — La fase dell'esperimento (es: "READY", "FAILED")
 * @param {string} [props.size] — "sm" | "md" | "lg"
 */
export default function PhaseBadge({ phase, size = 'md' }) {
  const config = PHASE_CONFIG[phase] || PHASE_CONFIG['IDLE'];
  const Icon = config.icon;

  const sizeClasses = {
    sm: 'text-[10px] px-2 py-0.5',
    md: 'text-xs px-3 py-1',
    lg: 'text-sm px-4 py-1.5',
  };

  return (
    <span className={`badge ${config.badge} ${sizeClasses[size]}`} id={`phase-badge-${phase || 'unknown'}`}>
      <Icon className={size === 'sm' ? 'w-3 h-3' : size === 'lg' ? 'w-5 h-5' : 'w-3.5 h-3.5'} />
      {config.label}
    </span>
  );
}
