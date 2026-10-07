import { Children, cloneElement, isValidElement, useId } from 'react';

// FormField renders the common "label + control + optional hint" stack used by
// the create forms. Pass the input/select/textarea as children so callers keep
// full control over the control's props (value, onChange, classes, etc.).
//
// The label is programmatically associated with the control: FormField mints an
// id with useId() and injects it into the child element, so screen readers
// announce the field name instead of "edit text, blank". A child that already
// carries an id keeps it (and the label points at that id instead).
//
// - `label`     : field label text (omit to render children only).
// - `labelExtra`: optional node rendered inline after the label (e.g. a lock icon).
// - `hint`      : optional helper text rendered under the control.
// - `labelClassName`: overrides the default label typography so a field can
//   match its surrounding form (e.g. the tighter `text-[12px]` rows).
export default function FormField({
  label,
  labelExtra,
  hint,
  children,
  className = '',
  labelClassName = 'block text-xs font-medium text-surface-400 mb-1',
}) {
  const generatedID = useId();
  const only = Children.count(children) === 1 ? Children.only(children) : null;
  const control = isValidElement(only) ? only : null;
  const controlID = control?.props?.id ?? generatedID;

  return (
    <div className={className}>
      {label != null && (
        <label className={labelClassName} htmlFor={control ? controlID : undefined}>
          {label}
          {labelExtra}
        </label>
      )}
      {control ? cloneElement(control, { id: controlID }) : children}
      {hint != null && <p className="text-[12px] text-surface-450 mt-1">{hint}</p>}
    </div>
  );
}
