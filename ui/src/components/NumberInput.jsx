// NumberInput is a plain text box that accepts digits only (no browser spinner
// arrows). It emits an integer via onChange, matching the old
// `parseInt(...) || 0` semantics so callers keep numeric state.
export default function NumberInput({ value, onChange, className = '', ...rest }) {
  return (
    <input
      type="text"
      inputMode="numeric"
      pattern="[0-9]*"
      className={className}
      value={value}
      onChange={(e) => {
        const digits = e.target.value.replace(/[^0-9]/g, '');
        onChange(digits === '' ? 0 : parseInt(digits, 10));
      }}
      {...rest}
    />
  );
}
