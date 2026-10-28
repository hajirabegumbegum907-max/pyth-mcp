'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PythClient, decimalValue } = require('../lib/client');
const { createMockPythServer } = require('./helpers');

let mock;
let root;
test.before(async () => { mock = await createMockPythServer(); });
test.after(async () => { if (mock) await mock.close(); });
test.beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pyth-client-test-'));
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

test('decimal conversion preserves exact text and numeric values', () => {
  assert.deepEqual(decimalValue('6700025000000', -8, 'price'), { text: '67000.25', number: 67000.25, raw: '6700025000000' });
  assert.deepEqual(decimalValue('1', -8, 'price'), { text: '0.00000001', number: 1e-8, raw: '1' });
  assert.deepEqual(decimalValue('12', 2, 'price'), { text: '1200', number: 1200, raw: '12' });
  assert.deepEqual(decimalValue(null, -8, 'price'), { text: null, number: null, raw: null });
});

test('catalog search filters by asset type and applies limits', async () => {
  const api = client();
  const result = await api.listFeeds({ query: 'USD', limit: 3 });
  assert.equal(result.count, 5);
  assert.equal(result.returned, 3);
  assert.equal(result.cached, false);
  assert.deepEqual(mock.state.catalogLimits, ['3']);
  const equity = await api.listFeeds({ query: 'AAPL', assetType: 'equity' });
  assert.equal(equity.feeds[0].symbol, 'Equity.US.AAPL/USD');
  api.close();
});

test('catalog TTL cache persists and force refresh bypasses it', async () => {
  const first = client();
  await first.listFeeds({ query: 'BTC' });
  first.close();
  const second = client();
  const cached = await second.listFeeds({ query: 'BTC' });
  assert.equal(cached.cached, true);
  assert.equal(mock.state.catalogRequests, 1);
  const fresh = await second.listFeeds({ query: 'BTC', forceRefresh: true });
  assert.equal(fresh.cached, false);
  assert.equal(mock.state.catalogRequests, 2);
  second.close();
});

test('latest price includes price, confidence, EMA, and publish time', async () => {
  const api = client();
  const quote = await api.getPrice('BTC/USD');
  assert.equal(quote.price, 67000.25);
  assert.equal(quote.priceText, '67000.25');
  assert.equal(quote.confidence, 12.5);
  assert.equal(quote.exponent, -8);
  assert.equal(quote.publishTimeIso, '2025-10-09T08:53:21.000Z');
  assert.equal(quote.cached, false);
  assert.equal(quote.metadata.proof_available, true);
  assert.equal(mock.state.catalogRequests, 0);
  api.close();
});

test('price cache works across clients and force refresh fetches a new update', async () => {
  const first = client();
  const original = await first.getPrice('BTC');
  first.close();
  const second = client();
  const cached = await second.getPrice('BTC/USD');
  assert.equal(cached.cached, true);
  assert.equal(cached.price, original.price);
  assert.equal(mock.state.priceRequests, 1);
  const fresh = await second.getPrice('BTC', { forceRefresh: true });
  assert.equal(fresh.cached, false);
  assert.notEqual(fresh.raw.price, original.raw.price);
  assert.equal(mock.state.priceRequests, 2);
  second.close();
});

test('batch prices reuse per-feed cache and fetch only missing feeds', async () => {
  const api = client();
  await api.getPrice('BTC/USD');
  const result = await api.getPrices(['BTC/USD', 'ETH/USD']);
  assert.equal(result.count, 2);
  assert.equal(result.cached, false);
  assert.equal(result.prices[0].cached, true);
  assert.equal(result.prices[1].cached, false);
  assert.deepEqual(mock.state.requestedIds[1], [result.prices[1].id]);
  const duplicates = await api.getPrices(['BTC', 'BTC/USD']);
  assert.equal(duplicates.count, 1);
  api.close();
});

test('batch prices return successes with structured partial errors', async () => {
  const api = client();
  const missingPrice = await api.getPrices(['BTC/USD', 'b'.repeat(64)]);
  assert.equal(missingPrice.count, 1);
  assert.equal(missingPrice.errorCount, 1);
  assert.equal(missingPrice.errors[0].code, 'PRICE_NOT_FOUND');
  const unknownSymbol = await api.getPrices(['ETH/USD', 'NOT-A-FEED']);
  assert.equal(unknownSymbol.count, 1);
  assert.equal(unknownSymbol.prices[0].symbol, 'Crypto.ETH/USD');
  assert.equal(unknownSymbol.errors[0].code, 'FEED_NOT_FOUND');
  api.close();
});

test('dynamic catalog resolution supports non-built-in symbols', async () => {
  const api = client();
  const feed = await api.resolveFeed('Equity.US.AAPL/USD');
  assert.equal(feed.id, 'a'.repeat(64));
  const quote = await api.getPrice('AAPL');
  assert.equal(quote.symbol, 'Equity.US.AAPL/USD');
  assert.equal(quote.priceText, '250');
  api.close();
});

test('unknown feed and missing price return domain errors', async () => {
  const api = client();
  await assert.rejects(api.getPrice('NOT-A-FEED'), (error) => error.code === 'FEED_NOT_FOUND');
  await assert.rejects(api.getPrice('b'.repeat(64)), (error) => error.code === 'PRICE_NOT_FOUND');
  api.close();
});

test('transient HTTP failures are retried with bounded attempts', async () => {
  const api = client({ retries: 2 });
  mock.state.failPrices = 1;
  const quote = await api.getPrice('ETH/USD');
  assert.equal(quote.price, 3500.75);
  assert.equal(mock.state.priceRequests, 2);
  api.close();
});

test('permanent HTTP errors are not retried', async () => {
  const api = new PythClient({
    rootDir: root,
    overrides: { baseUrl: mock.url, retries: 3 },
    fetch: async () => new Response('bad request', { status: 400 }),
  });
  await assert.rejects(api.listFeeds({ query: 'BTC' }), (error) => error.code === 'HERMES_HTTP_ERROR' && error.status === 400);
  api.close();
});

test('401 responses explain how to configure an API key', async () => {
  const api = new PythClient({
    rootDir: root,
    overrides: { baseUrl: mock.url, retries: 0 },
    fetch: async () => new Response('unauthorized', { status: 401 }),
  });
  await assert.rejects(api.getPrice('BTC/USD'), (error) => error.status === 401 && /PYTH_API_KEY/.test(error.message));
  api.close();
});

test('request timeout has a specific error code', async () => {
  const api = new PythClient({
    rootDir: root,
    overrides: { baseUrl: mock.url, retries: 0, timeoutMs: 100 },
    fetch: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }),
  });
  await assert.rejects(api.listFeeds(), (error) => error.code === 'HERMES_TIMEOUT');
  api.close();
});

test('configured API key is sent only as a Bearer authorization header', async () => {
  const api = client({ apiKey: 'test-secret' });
  await api.getPrice('BTC/USD');
  assert.equal(mock.state.authorization, 'Bearer test-secret');
  api.close();
});

test('zero cache TTL disables price cache reads and writes', async () => {
  const api = client();
  await api.getPrice('SOL/USD', { cacheTtlMs: 0 });
  await api.getPrice('SOL/USD', { cacheTtlMs: 0 });
  assert.equal(mock.state.priceRequests, 2);
  assert.equal(api.cache.peek(`price:${'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d'}`), undefined);
  api.close();
});
