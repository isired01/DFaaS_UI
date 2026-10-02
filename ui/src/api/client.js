import {
  reportApiResponse,
  reportApiFailure,
  reportClusterUnreachable,
} from '../lib/clusterStatus';

const API_BASE = '/api';

// Gateway wording when the Kubernetes call itself could not be completed —
// distinguishes "the cluster is unreachable" from an ordinary application 500.
const CLUSTER_UNREACHABLE_RE = /cluster|kubernetes|connection refused|timeout|deadline exceeded|no such host/i;

export async function request(endpoint, options = {}) {
  const url = `${API_BASE}${endpoint}`;

  let res;
  try {
    res = await fetch(url, {
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
      ...options,
    });
  } catch (err) {
    // Network-layer rejection, or the caller aborted us on unmount / next poll.
    reportApiFailure({ aborted: err?.name === 'AbortError' });
    throw err;
  }
  reportApiResponse(res.status);

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText }));
    const message = error.error || `Request failed: ${res.status}`;
    if (res.status >= 500 && CLUSTER_UNREACHABLE_RE.test(message)) {
      reportClusterUnreachable();
    }
    throw new Error(message);
  }

  // Read the body once as text and parse only when non-empty. Empty-bodied 2xx
  // responses (e.g. ActivateLoadTest's bare 202) would otherwise blow up on
  // res.json() with "Unexpected end of JSON input".
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // A truncated or non-JSON 2xx body would surface as a raw SyntaxError in the
    // UI; every non-2xx path here already reports a readable message.
    throw new Error(`Malformed response from ${endpoint} (HTTP ${res.status}): body is not valid JSON`);
  }
}

// --- Environments ---

export async function fetchEnvironments({ signal } = {}) {
  return (await request('/environments', { signal })) || [];
}

export async function fetchEnvironment(namespace, name, { signal } = {}) {
  return request(`/environments/${namespace}/${name}`, { signal });
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

export async function fetchLoadTests({ environment, signal } = {}) {
  const qs = environment ? `?environment=${encodeURIComponent(environment)}` : '';
  return (await request(`/loadtests${qs}`, { signal })) || [];
}

export async function fetchLoadTest(namespace, name, { signal } = {}) {
  return request(`/loadtests/${namespace}/${name}`, { signal });
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
// environment's S3 bucket and returns { url, contentType, filename, relocatable,
// path }. url is the absolute URL baked at upload, the mandatory fallback the
// generated script fetches the payload from. relocatable is true only for the
// in-cluster SeaweedFS, and then path ('/<bucket>/<key>') lets each generator
// fetch the object over its own DFAAS_ASSET_BASE instead. The response is
// returned as-is; payloadPatch (lib/scenarios.js) maps it onto the scenario.
// Multipart, so we must NOT set Content-Type — the browser sets the boundary
// itself.
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

export async function listS3Configs({ signal } = {}) {
  return (await request('/s3-configs', { signal })) || [];
}

export async function fetchS3Config(name, { signal } = {}) {
  return request(`/s3-configs/${encodeURIComponent(name)}`, { signal });
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
