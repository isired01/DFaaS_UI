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

export async function updateEnvironment(namespace, name, specPatch) {
  return request(`/environments/${namespace}/${name}`, {
    method: 'PATCH',
    body: JSON.stringify({ spec: specPatch }),
  });
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

// uploadLoadTestAsset uploads a file (k6 request payload, e.g. an image) to the
// environment's S3 bucket and returns { url, contentType, filename }. The URL is
// embedded by the client-side k6 generator as the request body. Multipart, so we
// must NOT set Content-Type — the browser sets the boundary itself.
export async function uploadLoadTestAsset(namespace, environment, file) {
  const form = new FormData();
  form.append('namespace', namespace);
  form.append('environment', environment);
  form.append('file', file);

  const res = await fetch(`${API_BASE}/loadtests/assets`, {
    method: 'POST',
    body: form,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

export async function activateLoadTest(namespace, name) {
  return request(`/loadtests/${namespace}/${name}/activate`, { method: 'POST' });
}

export async function abortLoadTest(namespace, name) {
  return request(`/loadtests/${namespace}/${name}/abort`, { method: 'PATCH' });
}

// --- S3 server configurations ---

export async function listS3Configs() {
  const data = await request('/s3-configs');
  return data.s3Configs || [];
}

export async function fetchS3Config(name) {
  return request(`/s3-configs/${encodeURIComponent(name)}`);
}

export async function createS3Config(payload) {
  return request('/s3-configs', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function deleteS3Config(name) {
  return request(`/s3-configs/${encodeURIComponent(name)}`, { method: 'DELETE' });
}

// --- YAML exports ---

async function fetchText(path) {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `Request failed: ${res.status}`);
  }
  return res.text();
}

export const fetchEnvironmentYAML = (namespace, name) =>
  fetchText(`/environments/${namespace}/${name}/yaml`);

export const fetchLoadTestYAML = (namespace, name) =>
  fetchText(`/loadtests/${namespace}/${name}/yaml`);

// --- YAML apply (kubectl apply -f equivalent) ---

async function postYAML(path, yamlText) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/yaml' },
    body: yamlText,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

export const createEnvironmentFromYAML = (yamlText) =>
  postYAML('/environments/yaml', yamlText);

export const createLoadTestFromYAML = (yamlText) =>
  postYAML('/loadtests/yaml', yamlText);

export function downloadTextAsFile(text, filename, mime = 'text/plain') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
