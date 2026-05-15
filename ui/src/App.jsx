import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import EnvironmentsList from './pages/EnvironmentsList';
import EnvironmentNew from './pages/EnvironmentNew';
import EnvironmentDetail from './pages/EnvironmentDetail';
import LoadTestsList from './pages/LoadTestsList';
import LoadTestNew from './pages/LoadTestNew';
import LoadTestDetail from './pages/LoadTestDetail';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<EnvironmentsList />} />
          <Route path="environments/new" element={<EnvironmentNew />} />
          <Route path="environments/:namespace/:name" element={<EnvironmentDetail />} />
          <Route path="environments/:namespace/:name/loadtests/new" element={<LoadTestNew />} />
          <Route path="loadtests" element={<LoadTestsList />} />
          <Route path="loadtests/:namespace/:name" element={<LoadTestDetail />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
