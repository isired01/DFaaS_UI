import { Outlet, Link, useLocation } from 'react-router-dom';
import { FlaskConical, LayoutDashboard, Github } from 'lucide-react';

export default function Layout() {
  const location = useLocation();
  const isHome = location.pathname === '/';

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="glass-surface sticky top-0 z-50 border-b border-surface-700/30">
        <div className="max-w-[1600px] mx-auto px-6 h-16 flex items-center justify-between">
          {/* Logo */}
          <Link to="/" className="flex items-center gap-3 group">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-dfaas-500 to-violet-500 
                          flex items-center justify-center shadow-lg shadow-dfaas-500/20
                          group-hover:shadow-xl group-hover:shadow-dfaas-500/30 
                          transition-all duration-300">
              <FlaskConical className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-lg font-bold tracking-tight bg-gradient-to-r from-white to-surface-300 bg-clip-text text-transparent">
                dFaaS
              </h1>
              <p className="text-[10px] text-surface-500 -mt-1 tracking-widest uppercase">
                Control Plane
              </p>
            </div>
          </Link>

          {/* Nav */}
          <nav className="flex items-center gap-2">
            <Link
              to="/"
              id="nav-dashboard"
              className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium
                         transition-all duration-200
                         ${isHome 
                           ? 'bg-dfaas-600/20 text-dfaas-400 border border-dfaas-500/30' 
                           : 'text-surface-400 hover:text-white hover:bg-surface-800/50'}`}
            >
              <LayoutDashboard className="w-4 h-4" />
              Dashboard
            </Link>
          </nav>

          {/* Status indicator */}
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-surface-800/50 border border-surface-700/50">
              <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              <span className="text-xs text-surface-400">Cluster Connected</span>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 max-w-[1600px] mx-auto w-full px-6 py-8">
        <Outlet />
      </main>

      {/* Footer */}
      <footer className="border-t border-surface-800/50 py-4">
        <div className="max-w-[1600px] mx-auto px-6 flex items-center justify-between">
          <p className="text-xs text-surface-600">
            dFaaS Control Plane — Tesi Magistrale
          </p>
          <p className="text-xs text-surface-600">
            Kubernetes Operator + React UI
          </p>
        </div>
      </footer>
    </div>
  );
}
