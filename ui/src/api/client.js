const API_BASE = '/api';

/**
 * Wrapper generico per le chiamate fetch verso il backend Go.
 * Gestisce errori e parsing JSON.
 */
async function request(endpoint, options = {}) {
  const url = `${API_BASE}${endpoint}`;
  
  const res = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
    ...options,
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(error.error || `Request failed: ${res.status}`);
  }

  return res.json();
}

/**
 * GET /api/experiments — Lista tutti gli esperimenti da tutti i namespace.
 */
export async function fetchExperiments() {
  const data = await request('/experiments');
  return data.experiments || [];
}

/**
 * GET /api/experiments/:namespace/:name — Dettaglio singolo esperimento.
 */
export async function fetchExperiment(namespace, name) {
  return request(`/experiments/${namespace}/${name}`);
}

/**
 * POST /api/k6/generate — Genera uno script k6 e il manifest YAML TestRun.
 */
export async function generateK6(scenarios) {
  return request('/k6/generate', {
    method: 'POST',
    body: JSON.stringify({ scenarios }),
  });
}

/**
 * POST /api/experiments/:namespace/:name/k6/launch — Genera e lancia TestRun sul cluster.
 */
export async function launchK6(namespace, name, scenarios, metricsQueries) {
  return request(`/experiments/${namespace}/${name}/k6/launch`, {
    method: 'POST',
    body: JSON.stringify({ scenarios, metricsQueries }),
  });
}

/**
 * POST /api/k6/upload — Carica un file .js di k6 esistente.
 * Restituisce il contenuto e il YAML generato.
 */
export async function uploadK6Script(file) {
  const formData = new FormData();
  formData.append('script', file);

  const res = await fetch(`${API_BASE}/k6/upload`, {
    method: 'POST',
    body: formData,
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(error.error || `Upload failed: ${res.status}`);
  }

  return res.json();
}
