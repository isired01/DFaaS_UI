import { Link } from 'react-router-dom';
import { AlertTriangle } from 'lucide-react';

// PageError is the whole-page read failure panel: the detail pages render it
// instead of their content when the read of the resource itself failed. The
// same markup was inlined byte-identically in three pages.
//
// ErrorAlert is the other one, and they are not interchangeable: that is the
// inline strip inside a form, where the form stays on screen.
export default function PageError({ message, back }) {
  return (
    <div className="glass-card p-8 text-center border-red-500/30 bg-red-500/5">
      <AlertTriangle className="w-10 h-10 text-red-400 mx-auto mb-3" />
      <p className="text-red-400">{message}</p>
      {back && (
        <Link to={back.to} className="btn-secondary mt-4 inline-flex">← {back.label}</Link>
      )}
    </div>
  );
}
