import { Component } from 'react';
import { useLocation } from 'react-router-dom';
import { AlertTriangle } from 'lucide-react';

// ErrorBoundary catches render-time exceptions in the routed pages and shows a
// fallback panel instead of a blank screen. Pages already handle their own
// fetch/error state and `return null` on missing data; this only guards against
// unexpected render crashes.
class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary]', error, info);
  }

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.error) {
      return (
        <div className="glass-card p-8 text-center border-red-500/30 bg-red-500/5 max-w-2xl mx-auto mt-12">
          <AlertTriangle className="w-10 h-10 text-red-400 mx-auto mb-3" />
          <h2 className="text-lg font-semibold text-white mb-1">Something went wrong</h2>
          <p className="text-sm text-red-400 break-words">{String(this.state.error?.message || this.state.error)}</p>
          <button onClick={this.handleReload} className="btn-secondary mt-4 inline-flex">
            Reload page
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// RouteErrorBoundary keys the boundary by pathname (which includes route
// params), so a caught error is reset on any navigation — including a
// param-only change like /environments/ns/a -> /environments/ns/b that reuses
// the same route element. Without the key the boundary instance is reused and
// its error state would stick on the fallback until a full reload.
export function RouteErrorBoundary({ children }) {
  const location = useLocation();
  return <ErrorBoundary key={location.pathname}>{children}</ErrorBoundary>;
}
