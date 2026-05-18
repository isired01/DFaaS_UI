import {
  Circle, Server, Activity,
  CheckCircle, Play, CheckCheck, XCircle, LineChart, Clock,
} from 'lucide-react';

const ENV_PHASE = {
  '':                  { badge: 'badge-idle',         icon: Circle,      label: 'Initializing' },
  'Idle':              { badge: 'badge-idle',         icon: Circle,      label: 'Idle' },
  'ProvisioningVMs':   { badge: 'badge-provisioning', icon: Server,      label: 'Provisioning VMs',                       spin: true },
  'ProvisioningInfra': { badge: 'badge-monitoring',   icon: Activity,    label: 'Provisioning k6 + monitoring (parallel)', spin: true },
  'Ready':             { badge: 'badge-ready',        icon: CheckCircle, label: 'Ready' },
  'Failed':            { badge: 'badge-failed',       icon: XCircle,     label: 'Failed' },
};

const LT_PHASE = {
  '':           { badge: 'badge-idle',       icon: Clock,      label: 'Pending' },
  'Pending':    { badge: 'badge-idle',       icon: Clock,      label: 'Pending' },
  'Running':    { badge: 'badge-running',    icon: Play,       label: 'Running',   spin: true },
  'Exporting':  { badge: 'badge-monitoring', icon: LineChart,  label: 'Exporting', spin: true },
  'Completed':  { badge: 'badge-completed',  icon: CheckCheck, label: 'Completed' },
  'Failed':     { badge: 'badge-failed',     icon: XCircle,    label: 'Failed' },
};

const MAPS = { env: ENV_PHASE, loadtest: LT_PHASE };

const SIZE_CLASSES = {
  sm: 'text-[10px] px-2 py-0.5',
  md: 'text-xs px-3 py-1',
  lg: 'text-sm px-4 py-1.5',
};

const ICON_CLASSES = {
  sm: 'w-3 h-3',
  md: 'w-3.5 h-3.5',
  lg: 'w-5 h-5',
};

export default function PhaseBadge({ phase, kind = 'env', size = 'md' }) {
  const map = MAPS[kind] || MAPS.env;
  const config = map[phase] || map[''] || { badge: 'badge-idle', icon: Circle, label: phase || 'Unknown' };
  const Icon = config.icon;

  return (
    <span className={`badge ${config.badge} ${SIZE_CLASSES[size]}`} id={`phase-badge-${phase || 'unknown'}`}>
      <Icon className={`${ICON_CLASSES[size]} ${config.spin ? 'animate-spin' : ''}`} />
      {config.label}
    </span>
  );
}
