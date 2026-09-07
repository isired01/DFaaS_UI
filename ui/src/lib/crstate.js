// What a CR's state means to a human, in one place.
//
// Phase sets, phase presentation (badge / icon / label / tone) and reason
// rendering for both CRDs. Before this file, "is this test in flight?" was
// answered four different ways in four files (polling, abort, terminal,
// env-edit blocking), phase colours were owned three times, and ~50 of the
// operator's 57 Condition reasons reached the user as raw camelCase.
//
// Phase and reason strings are protocol values from the operator CRDs
// (DFaaSOperator/api/v1). Labels here are presentation; tones map to the
// Tailwind classes at the bottom so colour is owned once.

import {
  Circle, Server, Activity, Download, AlertTriangle,
  CheckCircle, Play, CheckCheck, XCircle, LineChart, Clock, Ban, RefreshCw,
} from 'lucide-react';

// ── Environment ─────────────────────────────────────────────────────────────

const ENV_PHASES = {
  '':                       { badge: 'badge-idle',         icon: Circle,        label: 'Initializing', tone: 'idle' },
  'Idle':                   { badge: 'badge-idle',         icon: Circle,        label: 'Idle', tone: 'idle' },
  'ProvisioningVMs':        { badge: 'badge-idle',         icon: Server,        label: 'Preparing VMs (skipped — pre-existing)', tone: 'info' },
  'ProvisioningInfra':      { badge: 'badge-provisioning', icon: Activity,      label: 'Provisioning workers + k6 (parallel)', spin: true, tone: 'info' },
  'ProvisioningMonitoring': { badge: 'badge-monitoring',   icon: Download,      label: 'Installing monitoring stack', spin: true, tone: 'info' },
  'Ready':                  { badge: 'badge-ready',        icon: CheckCircle,   label: 'Ready', tone: 'ok' },
  'Degraded':               { badge: 'badge-cleanup',      icon: AlertTriangle, label: 'Degraded — monitoring unavailable', tone: 'warn' },
  'Failed':                 { badge: 'badge-failed',       icon: XCircle,       label: 'Failed', tone: 'error' },
  'Unreachable':            { badge: 'badge-cleanup',      icon: RefreshCw,     label: 'Unreachable — retrying SSH', spin: true, tone: 'warn' },
};

export const env = {
  /** Still being provisioned (list-page stat). */
  provisioning: (p) => p === 'ProvisioningVMs' || p === 'ProvisioningInfra' || p === 'ProvisioningMonitoring',
  /** A LoadTest may be dispatched against it. Same rule as the gateway and the
   *  operator: Degraded means infra is up and only the metrics export may fail. */
  dispatchable: (p) => p === 'Ready' || p === 'Degraded',
};

// ── LoadTest ────────────────────────────────────────────────────────────────

const LT_PHASES = {
  '':           { badge: 'badge-idle',       icon: Clock,      label: 'Pending', tone: 'idle' },
  'Pending':    { badge: 'badge-idle',       icon: Clock,      label: 'Pending', tone: 'idle' },
  'Running':    { badge: 'badge-running',    icon: Play,       label: 'Running',   spin: true, tone: 'warn' },
  'Exporting':  { badge: 'badge-monitoring', icon: LineChart,  label: 'Exporting', spin: true, tone: 'info' },
  'Completed':  { badge: 'badge-completed',  icon: CheckCheck, label: 'Completed', tone: 'ok' },
  'Failed':     { badge: 'badge-failed',     icon: XCircle,    label: 'Failed', tone: 'error' },
  'Aborted':    { badge: 'badge-aborted',    icon: Ban,        label: 'Aborted', tone: 'warn' },
};

export const lt = {
  /** Reached an end state; nothing will change without user action. */
  terminal: (p) => p === 'Completed' || p === 'Failed' || p === 'Aborted',
  /** Worth polling: everything that is not terminal (incl. the '' first tick). */
  inFlight: (p) => !lt.terminal(p),
  /** The operator still honours spec.stop: a queued or draft test is abortable,
   *  not just a running one — but an Exporting one is past the point. */
  abortable: (p) => p === '' || p === 'Pending' || p === 'Running',
  /** Owns its generators right now, so a node edit would destroy it. Same rule
   *  the gateway enforces (activeLoadTestNames): a suspended Pending test is
   *  parked and owns nothing. Takes the summary, not just the phase. */
  occupying: (t) => t.phase === 'Running' || t.phase === 'Exporting' || (t.phase === 'Pending' && !t.suspended),
};

// ── Remote k6 TestRun stages (k6-operator protocol values) ──────────────────

const TR_STAGES = {
  created:  'bg-surface-700/40 text-surface-300 border-surface-600/40',
  started:  'bg-amber-500/15 text-amber-400 border-amber-500/30',
  finished: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  stopped:  'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  error:    'bg-red-500/15 text-red-400 border-red-500/30',
};

export const testRun = {
  style: (stage) => TR_STAGES[stage] || TR_STAGES.created,
  done: (stage) => stage === 'finished' || stage === 'stopped',
};

// ── Presentation ────────────────────────────────────────────────────────────

const PHASE_TABLES = { env: ENV_PHASES, loadtest: LT_PHASES };

/** Badge/icon/label/tone for a phase. An unknown phase shows its literal name:
 *  the '' entry is "Initializing", and letting it catch unmapped phases would
 *  mislabel a phase this UI does not know. */
export function phase(kind, p) {
  const table = PHASE_TABLES[kind] || ENV_PHASES;
  return table[p] || { badge: 'badge-idle', icon: Circle, label: p || 'Unknown', tone: 'idle' };
}

const TONE_TEXT = { ok: 'text-emerald-400', warn: 'text-amber-400', error: 'text-red-400', info: 'text-dfaas-400', idle: 'text-surface-400', neutral: 'text-surface-450' };

/** Text colour class for a tone — the one place phase/reason colour lives. */
export const toneText = (tone) => TONE_TEXT[tone] || TONE_TEXT.neutral;

// Hand-written labels only for the reasons the UI already treated specially;
// everything else is humanised from the identifier. A new operator reason
// therefore renders readably on day one, and gets a curated label only if the
// default reads badly.
const REASONS = {
  // terminal failures — must not render as "in progress"
  AnsibleFailed:      { label: 'Ansible run failed', tone: 'error' },
  HelmFailed:         { label: 'Helm install failed', tone: 'error' },
  JobCreationFailed:  { label: 'Could not create the provisioning Job', tone: 'error' },
  CheckFailed:        { label: 'Readiness could not be evaluated', tone: 'error' },
  DispatchFailed:     { label: 'Remote dispatch failed', tone: 'error' },
  AllFailed:          { label: 'Every runner reported an error', tone: 'error' },
  PartialFailure:     { label: 'Some runners reported an error', tone: 'error' },
  InfraFailed:        { label: 'Provisioning failed', tone: 'error' },
  Failed:             { label: 'Failed', tone: 'error' },
  // degraded / waiting
  SSHUnreachable:     { label: 'Nodes unreachable over SSH', tone: 'warn' },
  Degraded:           { label: 'Degraded', tone: 'warn' },
  UserAborted:        { label: 'Aborted by the user', tone: 'warn' },
  ScheduledDelayedEnvNotReady: { label: 'Schedule fired, environment not ready', tone: 'warn' },
  // progress
  ScheduledArmed:     { label: 'Scheduled', tone: 'info' },
  ScheduledFired:     { label: 'Schedule fired', tone: 'ok' },
  AllSubsystemsReady: { label: 'All subsystems ready', tone: 'ok' },
  AllDispatched:      { label: 'All TestRuns dispatched', tone: 'ok' },
  AllFinished:        { label: 'All runners finished', tone: 'ok' },
  Completed:          { label: 'Completed', tone: 'ok' },
};

const humanise = (id) => (id || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());

/** Label and tone for a Condition reason. */
export function reason(r) {
  return REASONS[r] || { label: humanise(r), tone: 'neutral' };
}
