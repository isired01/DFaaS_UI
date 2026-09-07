// Self-check for lib/payloads/environment.js: `node src/lib/payloads/environment.selfcheck.mjs`.
import assert from 'node:assert/strict';
import { buildEnvironmentPayload } from './environment.js';

// Mirrors GET /api/meta/schema .node (internal/api/schema.go).
const rules = { nodeIDPattern: '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$', nodeIDMaxLength: 63, ipAddressMaxLength: 45, maxNodes: 50, uniqueIPAddress: true, requireEachRole: true };
const worker = (o = {}) => ({ nodeID: 'w1', ipAddress: '10.0.0.1', role: 'dfaas-worker', capacity: 'LOW', username: 'u', password: 'p', balancingStrategy: 'recalcstrategy',
  functions: [{ name: 'f', image: 'img', execTimeout: 5, maxInflight: 0, timeoutMs: '', maxRate: 100 }], ...o });
const gen = (o = {}) => ({ nodeID: 'g1', ipAddress: '10.0.0.2', role: 'k6-load-generator', capacity: 'LOW', username: 'u', password: 'p', functions: [], ...o });
const good = (o = {}) => ({ namespace: 'default', name: 'env', nodes: [worker(), gen()], links: [{ nodeA: 'w1', nodeB: 'g1', latencyMs: '12' }], s3ConfigName: '', mode: 'create', ...o });
const errorsOf = (o) => buildEnvironmentPayload(good(o), rules).errors;

// --- create: shape the gateway binds ---------------------------------------
{
  const { payload, patch, flipped, errors } = buildEnvironmentPayload(good(), rules);
  assert.deepEqual(errors, []); assert.deepEqual(flipped, []);
  assert.equal(payload.name, 'env'); assert.equal(payload.nodes.length, 2);
  const w = payload.nodes[0];
  assert.equal(w.balancingStrategy, 'recalcstrategy');
  assert.deepEqual(w.functions, [{ name: 'f', image: 'img', execTimeout: 5, maxRate: 100 }], 'cleared numeric fields omitted so CRD defaults apply');
  assert.equal(payload.nodes[1].balancingStrategy, undefined, 'k6 node carries no strategy');
  assert.deepEqual(payload.topology.links, [{ nodeA: 'w1', nodeB: 'g1', latencyMs: 12 }]);
  assert.equal(payload.s3ConfigRef, undefined);
  assert.equal(patch.clearS3ConfigRef, true, 'empty s3 → explicit clear on edit');
}
{
  const { payload, patch } = buildEnvironmentPayload(good({ s3ConfigName: ' mys3 ' }), rules);
  assert.deepEqual(payload.s3ConfigRef, { name: 'mys3' }); assert.deepEqual(patch.s3ConfigRef, { name: 'mys3' }); assert.equal(patch.clearS3ConfigRef, undefined);
}

// --- edit: role flips are reported, not acted on ---------------------------
{
  const { flipped } = buildEnvironmentPayload(good({ mode: 'edit', nodes: [worker({ _originalRole: 'k6-load-generator' }), gen({ _originalRole: 'k6-load-generator' })] }), rules);
  assert.deepEqual(flipped, ['w1: k6-load-generator → dfaas-worker']);
  const create = buildEnvironmentPayload(good({ nodes: [worker({ _originalRole: 'k6-load-generator' }), gen()] }), rules);
  assert.deepEqual(create.flipped, [], 'create mode never reports flips');
}

// --- every rule the gateway also enforces ----------------------------------
assert.match(errorsOf({ name: '' }).join(' '), /name is required/);
assert.match(errorsOf({ nodes: [] }).join(' '), /At least one node/);
assert.match(errorsOf({ nodes: [worker({ nodeID: 'G3' }), gen()] }).join(' '), /lowercase/);
assert.match(errorsOf({ nodes: [worker({ nodeID: 'a'.repeat(64) }), gen()] }).join(' '), /at most 63/);
assert.match(errorsOf({ nodes: [worker(), gen({ nodeID: 'w1' })] }).join(' '), /Duplicate nodeID/);
assert.match(errorsOf({ nodes: [worker(), gen({ ipAddress: '10.0.0.1' })] }).join(' '), /share the ipAddress/);
assert.match(errorsOf({ nodes: [worker({ ipAddress: '1'.repeat(46) }), gen()] }).join(' '), /at most 45/);
assert.match(errorsOf({ nodes: [worker({ username: ' ' }), gen()] }).join(' '), /missing username/);
assert.match(errorsOf({ nodes: [worker(), worker({ nodeID: 'w2', ipAddress: '10.0.0.9' })] }).join(' '), /k6 Load Generator/);
assert.match(errorsOf({ nodes: [gen(), gen({ nodeID: 'g2', ipAddress: '10.0.0.9' })] }).join(' '), /DFaaS Node/);
assert.equal(buildEnvironmentPayload(good({ nodes: Array.from({ length: 51 }, (_, i) => gen({ nodeID: `g${i}`, ipAddress: `10.1.${Math.floor(i / 250)}.${i % 250}` })) }), rules).errors.filter((e) => /At most 50/.test(e)).length, 1);

console.log('payloads/environment.js self-check: all assertions passed');
