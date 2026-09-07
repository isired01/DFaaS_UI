// Shared literals and phase maps used across pages and components.
// Values here are load-bearing protocol strings and Tailwind classnames —
// keep them byte-for-byte identical to what they replaced.

import {
  Circle, Server, Activity, Download, AlertTriangle,
  CheckCircle, Play, CheckCheck, XCircle, LineChart, Clock, Ban, RefreshCw,
} from 'lucide-react';

// LoadTest phases that warrant continued polling on the detail page.
export const ACTIVE_PHASES = new Set(['Pending', 'Running', 'Exporting', '']);

// LoadTest phases where the operator still honours spec.stop — a queued or
// draft test is abortable, not just a running one.
export const ABORTABLE_PHASES = new Set(['', 'Pending', 'Running']);

// Environment phases that count as "provisioning" for the list stats.
export const PROVISIONING_PHASES = new Set(['ProvisioningVMs', 'ProvisioningInfra', 'ProvisioningMonitoring']);

// Environment phases a LoadTest can be dispatched against. Mirrors the gateway
// (handlers_loadtest.go) and the operator's dispatcher: Degraded means the infra
// is up but monitoring is broken, so the test runs and only the metrics export
// may fail.
export const DISPATCHABLE_ENV_PHASES = new Set(['Ready', 'Degraded']);

// Remote k6 TestRun phase → badge classnames (LoadTestDetail).
export const TR_PHASE_STYLE = {
  created:  'bg-surface-700/40 text-surface-300 border-surface-600/40',
  started:  'bg-amber-500/15 text-amber-400 border-amber-500/30',
  finished: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  stopped:  'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  error:    'bg-red-500/15 text-red-400 border-red-500/30',
};

// Environment phase → badge style / icon / label (PhaseBadge kind="env").
export const ENV_PHASE = {
  '':                       { badge: 'badge-idle',         icon: Circle,      label: 'Initializing' },
  'Idle':                   { badge: 'badge-idle',         icon: Circle,      label: 'Idle' },
  'ProvisioningVMs':        { badge: 'badge-idle',         icon: Server,      label: 'Preparing VMs (skipped — pre-existing)' },
  'ProvisioningInfra':      { badge: 'badge-provisioning', icon: Activity,    label: 'Provisioning workers + k6 (parallel)', spin: true },
  'ProvisioningMonitoring': { badge: 'badge-monitoring',   icon: Download,    label: 'Installing monitoring stack',          spin: true },
  'Ready':                  { badge: 'badge-ready',        icon: CheckCircle, label: 'Ready' },
  'Degraded':               { badge: 'badge-cleanup',      icon: AlertTriangle, label: 'Degraded — monitoring unavailable' },
  'Failed':                 { badge: 'badge-failed',       icon: XCircle,     label: 'Failed' },
  'Unreachable':            { badge: 'badge-cleanup',      icon: RefreshCw,   label: 'Unreachable — retrying SSH', spin: true },
};

// LoadTest phase → badge style / icon / label (PhaseBadge kind="loadtest").
export const LT_PHASE = {
  '':           { badge: 'badge-idle',       icon: Clock,      label: 'Pending' },
  'Pending':    { badge: 'badge-idle',       icon: Clock,      label: 'Pending' },
  'Running':    { badge: 'badge-running',    icon: Play,       label: 'Running',   spin: true },
  'Exporting':  { badge: 'badge-monitoring', icon: LineChart,  label: 'Exporting', spin: true },
  'Completed':  { badge: 'badge-completed',  icon: CheckCheck, label: 'Completed' },
  'Failed':     { badge: 'badge-failed',     icon: XCircle,    label: 'Failed' },
  'Aborted':    { badge: 'badge-aborted',    icon: Ban,        label: 'Aborted' },
};
