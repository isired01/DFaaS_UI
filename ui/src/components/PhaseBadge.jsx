import { phase } from '../lib/crstate';

const SIZE_CLASSES = {
  sm: 'text-[12px] px-2 py-0.5',
  md: 'text-xs px-3 py-1',
  lg: 'text-sm px-4 py-1.5',
};

const ICON_CLASSES = {
  sm: 'w-3 h-3',
  md: 'w-3.5 h-3.5',
  lg: 'w-5 h-5',
};

export default function PhaseBadge({ phase: phaseValue, kind = 'env', size = 'md' }) {
  const config = phase(kind, phaseValue);
  const Icon = config.icon;

  return (
    <span className={`badge ${config.badge} ${SIZE_CLASSES[size]}`} id={`phase-badge-${phaseValue || 'unknown'}`}>
      <Icon className={`${ICON_CLASSES[size]} ${config.spin ? 'animate-spin' : ''}`} />
      {config.label}
    </span>
  );
}
