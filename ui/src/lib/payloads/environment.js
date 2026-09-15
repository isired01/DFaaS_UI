// Form state → CreateEnvironment payload or UpdateEnvironment patch. Pure:
// returns { payload, patch, flipped, errors } and never throws. `mode` is
// 'create' or 'edit' — the one place the dual-mode form branches on it for
// data (the page keeps the rendering branches).
/**
 * @param form { namespace, name, nodes, links, s3ConfigName, mode }
 * @param rules the gateway's node rules (GET /api/meta/schema).node
 */
export function buildEnvironmentPayload(form, rules) {
  const errors = [];
  const nodes = form.nodes || [];
  const nodeIDRe = new RegExp(rules.nodeIDPattern);

  if (!form.name) errors.push('Environment name is required');
  if (nodes.length === 0) errors.push('At least one node is required');
  if (nodes.length > rules.maxNodes) errors.push(`At most ${rules.maxNodes} nodes per environment`);

  const seen = new Set();
  const seenIPs = new Map();
  nodes.forEach((n, idx) => {
    const nid = (n.nodeID || '').trim();
    if (!nid) { errors.push(`Node #${idx + 1} is missing a nodeID`); return; }
    if (!nodeIDRe.test(nid)) errors.push(`Node '${nid}': nodeID must be lowercase letters, digits and '-' only (e.g. 'g3', not 'G3' — it becomes part of Kubernetes object names)`);
    if (nid.length > rules.nodeIDMaxLength) errors.push(`Node '${nid}': nodeID must be at most ${rules.nodeIDMaxLength} characters`);
    if (seen.has(nid)) errors.push(`Duplicate nodeID '${nid}'`);
    seen.add(nid);
    if (!n.role) errors.push(`Node '${nid}' is missing a role`);
    const ip = (n.ipAddress || '').trim();
    if (!ip) errors.push(`Node '${nid}' is missing ipAddress`);
    if (ip.length > rules.ipAddressMaxLength) errors.push(`Node '${nid}': ipAddress must be at most ${rules.ipAddressMaxLength} characters`);
    // One machine is one node (CRD CEL rule). Two nodes on the same box get
    // two libp2p identities; the Ansible run installs dfaas-agent twice and
    // every peer ends up dialling a dead peer ID.
    if (rules.uniqueIPAddress && ip && seenIPs.has(ip)) errors.push(`Nodes '${seenIPs.get(ip)}' and '${nid}' share the ipAddress ${ip} — one machine can only be one node`);
    if (ip) seenIPs.set(ip, nid);
    if (!(n.username || '').trim()) errors.push(`Node '${nid}' is missing username`);
    if (!n.password) errors.push(`Node '${nid}' is missing password`);
    // Mirrors the CRD's CEL rule on EnvironmentNode. A worker with no functions
    // serves nothing, and the operator's inventory turns the empty list into the
    // JSON literal `null`, which kills the Ansible prune task. Caught here so
    // the user gets an inline error instead of a raw 422.
    if (n.role === 'dfaas-worker' && (n.functions || []).length === 0) {
      errors.push(`Node '${nid}' is a DFaaS Node with no functions — a worker must deploy at least one`);
    }
  });
  if (rules.requireEachRole) {
    // Same rule the gateway enforces: a single-role environment reaches Ready
    // and only fails once a load test is dispatched at it.
    const roles = new Set(nodes.map((n) => n.role));
    if (!roles.has('dfaas-worker')) errors.push('At least one node must be a DFaaS Node — an environment with no workers has nothing to load-test');
    if (!roles.has('k6-load-generator')) errors.push('At least one node must be a k6 Load Generator — an environment with no generators cannot run a load test');
  }

  const nodesOut = nodes.map((n) => {
    const node = {
      nodeID: (n.nodeID || '').trim(),
      ipAddress: (n.ipAddress || '').trim(),
      role: n.role,
      capacity: n.capacity,
      username: (n.username || '').trim(),
      password: n.password,
    };
    if (n.role === 'dfaas-worker') {
      node.balancingStrategy = n.balancingStrategy;
      if ((n.functions || []).length > 0) {
        node.functions = n.functions.map((f) => {
          const fn = { name: f.name, image: f.image };
          // Omit numeric fields the user cleared so the CRD default applies.
          // NumberInput reports a cleared box as 0 and none of these accept 0
          // (maxRate has Minimum=1; the others are timeouts/limits).
          for (const k of ['execTimeout', 'maxInflight', 'timeoutMs', 'maxRate']) {
            const v = parseInt(f[k]);
            if (v > 0) fn[k] = v;
          }
          return fn;
        });
      }
    }
    return node;
  });
  const topology = {
    links: (form.links || []).map((l) => ({ nodeA: l.nodeA, nodeB: l.nodeB, latencyMs: parseInt(l.latencyMs) || 0 })),
  };
  const trimmedS3 = (form.s3ConfigName || '').trim();

  const payload = { namespace: form.namespace, name: form.name, nodes: nodesOut, topology };
  if (trimmedS3) payload.s3ConfigRef = { name: trimmedS3 };

  // Edit: the whole node array replaces (merge-patch semantics); an explicit
  // clear of s3ConfigRef is a separate flag because omitting the field would
  // leave the previous reference untouched.
  const patch = { nodes: nodesOut, topology };
  if (trimmedS3) patch.s3ConfigRef = { name: trimmedS3 };
  else patch.clearS3ConfigRef = true;

  // Nodes whose role changed: the operator wipes and reprovisions them.
  const flipped = form.mode === 'edit'
    ? nodes.filter((n) => n._originalRole && n.role !== n._originalRole).map((n) => `${n.nodeID}: ${n._originalRole} → ${n.role}`)
    : [];

  return { payload, patch, flipped, errors };
}
