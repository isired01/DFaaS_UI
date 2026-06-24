// FormField renders the common "label + control + optional hint" stack used by
// the create forms. Pass the input/select/textarea as children so callers keep
// full control over the control's props (value, onChange, classes, etc.).
//
// - `label`     : field label text (omit to render children only).
// - `labelExtra`: optional node rendered inline after the label (e.g. a lock icon).
// - `hint`      : optional helper text rendered under the control.
// - `labelClassName` / `hintClassName`: override the default typography so a
//   field can match its surrounding form (e.g. the tighter `text-[12px]` rows).
export default function FormField({
  label,
  labelExtra,
  hint,
  children,
  className = '',
  labelClassName = 'block text-xs font-medium text-surface-400 mb-1',
  hintClassName = 'text-[12px] text-surface-500 mt-1',
}) {
  return (
    <div className={className}>
      {label != null && (
        <label className={labelClassName}>
          {label}
          {labelExtra}
        </label>
      )}
      {children}
      {hint != null && <p className={hintClassName}>{hint}</p>}
    </div>
  );
}
