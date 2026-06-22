// ErrorAlert is the inline form error card shared by the create/edit forms
// (EnvironmentNew, S3ConfigNew, LoadTestNew). Pass the text via `message`
// (or `children`). `className` appends extra utility classes for sites that
// need them (e.g. LoadTestNew adds `whitespace-pre-line`).
export default function ErrorAlert({ message, children, className = '' }) {
  return (
    <div className={`p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-sm${className ? ` ${className}` : ''}`}>
      {message ?? children}
    </div>
  );
}
