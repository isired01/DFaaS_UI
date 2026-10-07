import { useSyncExternalStore } from 'react';
import { Outlet, Link, useLocation } from 'react-router-dom';
import { FlaskConical, LayoutDashboard, TestTube2, Database } from 'lucide-react';
import { subscribeClusterStatus, getClusterStatus } from '../lib/clusterStatus';

// Reflects whether API calls are actually reaching the cluster. Status comes
// from real traffic (see lib/clusterStatus.js), so before the first request it
// reads "Cluster —".
const CLUSTER_BADGE = {
  ok: { dot: 'bg-emerald-400 animate-pulse', text: 'Cluster Connected' },
  down: { dot: 'bg-red-500', text: 'Cluster Unreachable' },
  unknown: { dot: 'bg-surface-500', text: 'Cluster —' },
};

function ClusterBadge() {
  const status = useSyncExternalStore(subscribeClusterStatus, getClusterStatus, getClusterStatus);
  const { dot, text } = CLUSTER_BADGE[status] || CLUSTER_BADGE.unknown;
  return (
    <div
      className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-surface-800/50 border border-surface-700/50"
      role="status"
      aria-live="polite"
      data-cluster-status={status}
    >
      <div className={`w-2 h-2 rounded-full ${dot}`} />
      <span className="text-xs text-surface-400">{text}</span>
    </div>
  );
}

export default function Layout() {
  const location = useLocation();
  const pathname = location.pathname;
  const isS3Configs = pathname.startsWith('/s3-configs');
  const isEnvironments = (pathname === '/' || pathname.startsWith('/environments')) && !isS3Configs;
  const isLoadTests = pathname.startsWith('/loadtests');

  return (
    <div className="min-h-screen flex flex-col">
      <header className="glass-surface sticky top-0 z-50 border-b border-surface-700/30">
        <div className="max-w-[1600px] mx-auto px-6 h-16 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-3 group">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-dfaas-500 to-violet-500
                          flex items-center justify-center shadow-lg shadow-dfaas-500/20
                          group-hover:shadow-xl group-hover:shadow-dfaas-500/30
                          transition-all duration-300">
              <FlaskConical className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-lg font-bold tracking-tight bg-gradient-to-r from-white to-surface-300 bg-clip-text text-transparent">
                DFaaS
              </h1>
              <p className="text-[12px] text-surface-450 -mt-1 tracking-widest uppercase">
                Control Plane
              </p>
            </div>
          </Link>

          <nav className="flex items-center gap-2">
            <NavLink to="/" active={isEnvironments && !isLoadTests} icon={LayoutDashboard} label="Environments" id="nav-environments" />
            <NavLink to="/loadtests" active={isLoadTests} icon={TestTube2} label="Load Tests" id="nav-loadtests" />
            <NavLink to="/s3-configs" active={isS3Configs} icon={Database} label="S3 Configurations" id="nav-s3-configs" />
          </nav>

          <div className="flex items-center gap-3">
            <ClusterBadge />
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-[1600px] mx-auto w-full px-6 py-8">
        <Outlet />
      </main>

      <footer className="border-t border-surface-800/50 py-4">
        <div className="max-w-[1600px] mx-auto px-6 flex items-center justify-between">
          <p className="text-xs text-surface-450">
            DFaaS Control Plane — built as a Master's thesis project at the University of Milano-Bicocca
          </p>
          <p className="text-xs text-surface-450">
            Kubernetes Operator + React UI
          </p>
        </div>
      </footer>
    </div>
  );
}

function NavLink({ to, active, icon: Icon, label, id }) {
  return (
    <Link
      to={to}
      id={id}
      className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium
                  transition-all duration-200
                  ${active
          ? 'bg-dfaas-600/20 text-dfaas-400 border border-dfaas-500/30'
          : 'text-surface-400 hover:text-white hover:bg-surface-800/50'}`}
    >
      <Icon className="w-4 h-4" />
      {label}
    </Link>
  );
}
