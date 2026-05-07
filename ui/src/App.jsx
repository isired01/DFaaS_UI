import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import ExperimentDetail from './pages/ExperimentDetail';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<Dashboard />} />
          <Route path="experiments/:namespace/:name" element={<ExperimentDetail />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
