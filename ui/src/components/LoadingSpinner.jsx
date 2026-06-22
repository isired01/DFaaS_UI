// LoadingSpinner is the page-level loading indicator shown while a detail or
// form page fetches its initial data. Markup is shared verbatim across
// EnvironmentDetail, LoadTestDetail, and LoadTestNew.
export default function LoadingSpinner() {
  return (
    <div className="flex items-center justify-center py-32">
      <div className="w-10 h-10 border-3 border-dfaas-500/30 border-t-dfaas-500 rounded-full animate-spin" />
    </div>
  );
}
