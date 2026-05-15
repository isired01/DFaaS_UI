const API_BASE = '/api';

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

  if (res.status === 204) return null;
  return res.json();
}

// --- Environments ---

export async function fetchEnvironments() {
  const data = await request('/environments');
  return data.environments || [];
}

export async function fetchEnvironment(namespace, name) {
  return request(`/environments/${namespace}/${name}`);
}

export async function createEnvironment(payload) {
  return request('/environments', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function deleteEnvironment(namespace, name) {
  return request(`/environments/${namespace}/${name}`, { method: 'DELETE' });
}

// --- LoadTests ---

export async function fetchLoadTests({ environment } = {}) {
  const qs = environment ? `?environment=${encodeURIComponent(environment)}` : '';
  const data = await request(`/loadtests${qs}`);
  return data.loadtests || [];
}

export async function fetchLoadTest(namespace, name) {
  return request(`/loadtests/${namespace}/${name}`);
}

export async function createLoadTest(payload) {
  return request('/loadtests', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function deleteLoadTest(namespace, name) {
  return request(`/loadtests/${namespace}/${name}`, { method: 'DELETE' });
}
