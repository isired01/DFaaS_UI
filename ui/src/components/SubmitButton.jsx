// SubmitButton is the primary form-submit button shared by the create/edit
// forms (EnvironmentNew, S3ConfigNew, LoadTestNew). While `loading` is true it
// renders an inline spinner followed by `loadingLabel`; otherwise it renders
// `children` (the idle content, e.g. an icon + label). `disabled` is passed
// through verbatim so each page keeps its own disable condition.
export default function SubmitButton({ loading, disabled, loadingLabel, children }) {
  return (
    <button type="submit" disabled={disabled} className="btn-primary">
      {loading
        ? <><div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />{loadingLabel}</>
        : children}
    </button>
  );
}
