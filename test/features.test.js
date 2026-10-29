'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PythClient, parseRetryAfter } = require('../lib/client');
const { createMockPythServer } = require('./helpers');

let mock;
let root;
test.before(async () => { mock = await createMockPythServer(); });
test.after(async () => { if (mock) await mock.close(); });
test.beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pyth-features-test-'));
  mock.state.catalogRequests = 0;
  mock.state.catalogLimits = [];
  mock.state.priceRequests = 0;
  mock.state.requestedIds = [];
  mock.state.failCatalog = 0;
  mock.state.failPrices = 0;
  mock.state.tick = 0;
});
test.afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function client(overrides = {}) {
  return new PythClient({ rootDir: root, overrides: { baseUrl: mock.url, retries: 0, ...overrides }, retryBackoffMs: 1 });
}

test('price updates expose staleness relative to publish time', async () => {
  const api = client();
  const quote = await api.getPrice('BTC/USD', { forceRefresh: true });
  assert.equal(typeof quote.stalenessSeconds, 'number');
  assert.equal(typeof quote.stale, 'boolean');
  assert.ok(quote.stalenessSeconds >= 0);
  assert.equal(quote.stale, quote.stalenessSeconds > 60);
  api.close();
});

test('price history records fresh updates newest last', async () => {
  const api = client();
  await api.getPrice('ETH/USD', { forceRefresh: true, cacheTtlMs: 0 });
  await api.getPrice('ETH/USD', { forceRefresh: true, cacheTtlMs: 0 });
  const history = await api.getPriceHistory('ETH/USD');
  assert.equal(history.count, 2);
  assert.equal(history.returned, 2);
  assert.ok(BigInt(history.prices[1].raw.price) > BigInt(history.prices[0].raw.price));
  assert.ok(history.prices[0].publishTime < history.prices[1].publishTime);
  api.close();
});

test('price history honors the limit option', async () => {
  const api = client();
  for (let index = 0; index < 3; index += 1) await api.getPrice('SOL/USD', { forceRefresh: true, cacheTtlMs: 0 });
  const history = await api.getPriceHistory('SOL/USD', { limit: 2 });
  assert.equal(history.count, 3);
  assert.equal(history.returned, 2);
  api.close();
});

test('allowStale returns the last known price when refresh fails', async () => {
  const api = client();
  await api.getPrice('BTC/USD', { forceRefresh: true, cacheTtlMs: 0 });
  mock.state.failPrices = 5;
  const result = await api.getPrices(['BTC/USD'], { allowStale: true, cacheTtlMs: 0 });
  assert.equal(result.prices.length, 1);
  assert.equal(result.prices[0].stale, true);
  assert.equal(result.prices[0].staleSource, 'history');
  api.close();
});

test('refresh failure without allowStale surfaces the error', async () => {
  const api = client();
  mock.state.failPrices = 5;
  await assert.rejects(api.getPrice('BTC/USD', { cacheTtlMs: 0 }), (error) => error.code === 'HERMES_HTTP_ERROR');
  api.close();
});

test('parseRetryAfter handles seconds and HTTP dates', () => {
  assert.equal(parseRetryAfter('2'), 2000);
  assert.equal(parseRetryAfter('0'), 0);
  assert.equal(parseRetryAfter(''), null);
  assert.equal(parseRetryAfter('garbage'), null);
  const future = parseRetryAfter(new Date(Date.now() + 5000).toUTCString());
  assert.ok(future !== null && future > 3000 && future <= 5000);
});

test('user agent carries the package version from package.json', async () => {
  const version = require('../package.json').version;
  let captured = null;
  const api = new PythClient({
    rootDir: root,
    overrides: { baseUrl: mock.url, retries: 0 },
    fetch: async (url, options) => {
      captured = options.headers['user-agent'];
      return {
        status: 200,
        statusText: 'OK',
        ok: true,
        headers: { get: () => null },
        text: async () => '[]',
      };
    },
  });
  await api.request('/v2/price_feeds', { query: 'BTC' });
  api.close();
  assert.equal(captured, `pyth-mcp/${version}`);
  assert.equal(version, '0.1.2');
});
