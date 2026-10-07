// Shared date/time formatting helpers.
//
// These wrap the en-GB locale patterns. Two distinct shapes exist and produce
// different output, so they are kept as separate functions:
//
//   formatDateTime — `toLocaleString('en-GB')` (locale default date + time)
//   formatDate     — `toLocaleDateString('en-GB', { ... })` (explicit options)
//
// Callers that need a "missing value" placeholder keep their own guard
// (e.g. `value ? formatDateTime(value) : '—'`).

// formatDateTime renders a date+time using the en-GB locale defaults.
export function formatDateTime(d) {
  return new Date(d).toLocaleString('en-GB');
}

// formatDate renders an abbreviated date+time (e.g. "01 Jun 2026, 14:30")
// using the explicit en-GB options shared by the list pages.
export function formatDate(d) {
  return new Date(d).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
