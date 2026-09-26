import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';
import { startMockProvider, jsonHandler } from './helpers.js';

let mockPrimary;
let mockFallback;
let quotaspillServer;
let quotaspillUrl;
let callCounts;

function buildConfig(overrides = {}) {
  return {
    port: 0,
    statsFile: '.test-stats.json',
    chains: {
      anthropic: [
        { name: 'mock-primary', kind: 'primary', baseUrl: mockPrimary.url, apiKey: 'test-key' },
        { name: 'mock-fallback', kind: 'fallback', baseUrl: mockFallback.url, apiKey: 'test-key' },
      ],
    },
    budget: { anthropic: { monthlyRequestCap: null } },
    pricing: {},
    ...overrides,
  };
}

function startQuotaSpill(config) {
  return new Promise((resolve) => {
    const server = createServer(config, { stats: {}, statsPath: null });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

before(async () => {
  callCounts = { primary: 0, fallback: 0 };
  mockPrimary = await startMockProvider((req, res, body) => {
    callCounts.primary += 1;
    req.__lastBody = body;
    globalThis.__primaryHandler(req, res, body);
  });
  mockFallback = await startMockProvider((req, res, body) => {
    callCounts.fallback += 1;
    globalThis.__fallbackHandler(req, res, body);
  });
});

after(async () => {
  await mockPrimary.close();
  await mockFallback.close();
  if (quotaspillServer) await new Promise((r) => quotaspillServer.close(r));
});

test('primary success: response and usage are relayed straight through', async () => {
  globalThis.__primaryHandler = jsonHandler(200, {
    id: 'msg_1',
    usage: { input_tokens: 10, output_tokens: 20 },
  });
  globalThis.__fallbackHandler = jsonHandler(200, {});

  ({ server: quotaspillServer, url: quotaspillUrl } = await startQuotaSpill(buildConfig()));

  const res = await fetch(`${quotaspillUrl}/v1/messages`, {
    method: 'POST',
    body: JSON.stringify({ model: 'claude-x', messages: [] }),
  });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-quotaspill-source'), 'primary:mock-primary');
  assert.equal(body.id, 'msg_1');

  const stats = await (await fetch(`${quotaspillUrl}/api/stats`)).json();
  assert.equal(stats.chains.anthropic.allTime.requests, 1);
  assert.equal(stats.chains.anthropic.allTime.primaryInputTokens, 10);
  assert.equal(stats.chains.anthropic.allTime.primaryOutputTokens, 20);

  await new Promise((r) => quotaspillServer.close(r));
});

test('primary rate-limited (429): fails over to fallback transparently', async () => {
  globalThis.__primaryHandler = jsonHandler(429, { error: { type: 'rate_limit_error', message: 'slow down' } });
  globalThis.__fallbackHandler = jsonHandler(200, { id: 'msg_2', usage: { input_tokens: 5, output_tokens: 5 } });

  ({ server: quotaspillServer, url: quotaspillUrl } = await startQuotaSpill(buildConfig()));

  const res = await fetch(`${quotaspillUrl}/v1/messages`, {
    method: 'POST',
    body: JSON.stringify({ model: 'claude-x', messages: [] }),
  });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-quotaspill-source'), 'fallback:mock-fallback');
  assert.equal(body.id, 'msg_2');

  await new Promise((r) => quotaspillServer.close(r));
});

test('all providers exhausted: returns 502 with a labeled error, no silent success', async () => {
  globalThis.__primaryHandler = jsonHandler(429, { error: { type: 'rate_limit_error' } });
  globalThis.__fallbackHandler = jsonHandler(529, { error: { type: 'overloaded_error' } });

  ({ server: quotaspillServer, url: quotaspillUrl } = await startQuotaSpill(buildConfig()));

  const res = await fetch(`${quotaspillUrl}/v1/messages`, {
    method: 'POST',
    body: JSON.stringify({ model: 'claude-x', messages: [] }),
  });
  const body = await res.json();

  assert.equal(res.status, 502);
  assert.equal(body.error.type, 'quotaspill_all_providers_exhausted');

  await new Promise((r) => quotaspillServer.close(r));
});

test('non-quota error (400 bad request) from primary is relayed, not failed over', async () => {
  let fallbackHit = false;
  globalThis.__primaryHandler = jsonHandler(400, { error: { type: 'invalid_request_error', message: 'bad field' } });
  globalThis.__fallbackHandler = (req, res) => {
    fallbackHit = true;
    jsonHandler(200, {})(req, res);
  };

  ({ server: quotaspillServer, url: quotaspillUrl } = await startQuotaSpill(buildConfig()));

  const res = await fetch(`${quotaspillUrl}/v1/messages`, {
    method: 'POST',
    body: JSON.stringify({ model: 'claude-x', messages: [] }),
  });
  const body = await res.json();

  assert.equal(res.status, 400);
  assert.equal(body.error.type, 'invalid_request_error');
  assert.equal(fallbackHit, false, 'fallback must not be called for a non-quota error');

  await new Promise((r) => quotaspillServer.close(r));
});

test('monthly budget cap reached: skips primary entirely, routes straight to fallback', async () => {
  let primaryHit = false;
  globalThis.__primaryHandler = (req, res) => {
    primaryHit = true;
    jsonHandler(200, { id: 'should-not-be-used' })(req, res);
  };
  globalThis.__fallbackHandler = jsonHandler(200, { id: 'from-fallback' });

  const config = buildConfig({ budget: { anthropic: { monthlyRequestCap: 0 } } });
  ({ server: quotaspillServer, url: quotaspillUrl } = await startQuotaSpill(config));

  const res = await fetch(`${quotaspillUrl}/v1/messages`, {
    method: 'POST',
    body: JSON.stringify({ model: 'claude-x', messages: [] }),
  });
  const body = await res.json();

  assert.equal(res.headers.get('x-quotaspill-source'), 'fallback:mock-fallback');
  assert.equal(body.id, 'from-fallback');
  assert.equal(primaryHit, false, 'primary must not be called once its monthly cap is reached');

  await new Promise((r) => quotaspillServer.close(r));
});
