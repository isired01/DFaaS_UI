import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import { RouteErrorBoundary as ErrorBoundary } from './components/ErrorBoundary';
import EnvironmentsList from './pages/EnvironmentsList';
import EnvironmentNew from './pages/EnvironmentNew';
import EnvironmentDetail from './pages/EnvironmentDetail';
import LoadTestsList from './pages/LoadTestsList';
import LoadTestNew from './pages/LoadTestNew';
import LoadTestDetail from './pages/LoadTestDetail';
import S3ConfigsList from './pages/S3ConfigsList';
import S3ConfigNew from './pages/S3ConfigNew';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<ErrorBoundary><EnvironmentsList /></ErrorBoundary>} />
          <Route path="environments/new" element={<ErrorBoundary><EnvironmentNew /></ErrorBoundary>} />
          <Route path="environments/:namespace/:name/edit" element={<ErrorBoundary><EnvironmentNew mode="edit" /></ErrorBoundary>} />
          <Route path="environments/:namespace/:name" element={<ErrorBoundary><EnvironmentDetail /></ErrorBoundary>} />
          <Route path="environments/:namespace/:name/loadtests/new" element={<ErrorBoundary><LoadTestNew /></ErrorBoundary>} />
          <Route path="loadtests" element={<ErrorBoundary><LoadTestsList /></ErrorBoundary>} />
          <Route path="loadtests/:namespace/:name" element={<ErrorBoundary><LoadTestDetail /></ErrorBoundary>} />
          <Route path="s3-configs" element={<ErrorBoundary><S3ConfigsList /></ErrorBoundary>} />
          <Route path="s3-configs/new" element={<ErrorBoundary><S3ConfigNew /></ErrorBoundary>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
