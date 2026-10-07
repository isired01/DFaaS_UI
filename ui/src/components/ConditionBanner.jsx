import { Info } from 'lucide-react';
import { reason as reasonOf, tonePanel } from '../lib/crstate';

// ConditionBanner renders one Condition as an inline banner, with the curated
// label and the tone that crstate already holds for its reason.
// Renders nothing when there is no Condition to show.
export default function ConditionBanner({ condition }) {
  if (!condition) return null;
  const { label, tone } = reasonOf(condition.reason);
  return (
    <div className={`p-3 rounded-xl border text-sm flex items-start gap-2 ${tonePanel(tone)}`}>
      <Info className="w-4 h-4 mt-0.5 flex-shrink-0" />
      <span><strong>{label}</strong>{condition.message ? ` — ${condition.message}` : ''}</span>
    </div>
  );
}
