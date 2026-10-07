import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import { RouteErrorBoundary } from './components/ErrorBoundary';
import EnvironmentsList from './pages/EnvironmentsList';
import EnvironmentNew from './pages/EnvironmentNew';
import EnvironmentDetail from './pages/EnvironmentDetail';
import LoadTestsList from './pages/LoadTestsList';
import LoadTestNew from './pages/LoadTestNew';
import LoadTestDetail from './pages/LoadTestDetail';
import S3ConfigsList from './pages/S3ConfigsList';
import S3ConfigNew from './pages/S3ConfigNew';
import S3ConfigDetail from './pages/S3ConfigDetail';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<RouteErrorBoundary><EnvironmentsList /></RouteErrorBoundary>} />
          <Route path="environments/new" element={<RouteErrorBoundary><EnvironmentNew /></RouteErrorBoundary>} />
          <Route path="environments/:namespace/:name/edit" element={<RouteErrorBoundary><EnvironmentNew mode="edit" /></RouteErrorBoundary>} />
          <Route path="environments/:namespace/:name" element={<RouteErrorBoundary><EnvironmentDetail /></RouteErrorBoundary>} />
          <Route path="environments/:namespace/:name/loadtests/new" element={<RouteErrorBoundary><LoadTestNew /></RouteErrorBoundary>} />
          <Route path="loadtests" element={<RouteErrorBoundary><LoadTestsList /></RouteErrorBoundary>} />
          <Route path="loadtests/:namespace/:name" element={<RouteErrorBoundary><LoadTestDetail /></RouteErrorBoundary>} />
          <Route path="s3-configs" element={<RouteErrorBoundary><S3ConfigsList /></RouteErrorBoundary>} />
          <Route path="s3-configs/new" element={<RouteErrorBoundary><S3ConfigNew /></RouteErrorBoundary>} />
          <Route path="s3-configs/:name" element={<RouteErrorBoundary><S3ConfigDetail /></RouteErrorBoundary>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
