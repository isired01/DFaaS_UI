import { Info } from 'lucide-react';

// InfoTooltip renders a small (?) info icon with a hover/focus tooltip. Zero
// dependency, styled to match the glass theme. Place it inline inside a field
// label. Reveals on hover and on keyboard focus (group-focus-within).
export default function InfoTooltip({ text }) {
  return (
    <span className="group relative inline-flex align-middle" tabIndex={0}>
      <Info className="w-3 h-3 text-surface-450 hover:text-surface-300 cursor-help" />
      <span
        role="tooltip"
        className="pointer-events-none absolute left-0 bottom-full z-30 mb-1.5
                   w-max max-w-[260px] rounded-lg border border-surface-700 bg-surface-900
                   px-2.5 py-1.5 text-[13px] leading-snug text-surface-200 shadow-lg shadow-black/40
                   opacity-0 transition-opacity duration-150
                   group-hover:opacity-100 group-focus-within:opacity-100"
      >
        {text}
      </span>
    </span>
  );
}
