// ErrorAlert is the inline error card of the forms and the environment picker.
// Pass the text via `message`. `className` appends extra utility classes
// (e.g. LoadTestNew adds `whitespace-pre-line`).
export default function ErrorAlert({ message, className = '' }) {
  return (
    <div className={`p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-sm${className ? ` ${className}` : ''}`}>
      {message}
    </div>
  );
}
