'use strict';

const http = require('node:http');
const { MAJOR_FEEDS } = require('../lib/constants');

const FEED_ROWS = MAJOR_FEEDS.map((feed) => ({
  id: feed.id,
  attributes: {
    asset_type: feed.assetType,
    base: feed.base,
    quote_currency: feed.quoteCurrency,
    symbol: feed.symbol,
    description: feed.name,
  },
}));
FEED_ROWS.push({
  id: 'a'.repeat(64),
  attributes: {
    asset_type: 'equity', base: 'AAPL', quote_currency: 'USD',
    symbol: 'Equity.US.AAPL/USD', description: 'Apple / US Dollar',
  },
});

const BASE_PRICES = {
  'Crypto.BTC/USD': '6700025000000',
  'Crypto.ETH/USD': '350075000000',
  'Crypto.SOL/USD': '12345000000',
  'Crypto.USDC/USD': '99990000',
  'Crypto.USDT/USD': '100010000',
};

function json(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  response.end(text);
}

async function createMockPythServer() {
  const state = {
    catalogRequests: 0,
    catalogLimits: [],
    priceRequests: 0,
    failCatalog: 0,
    failPrices: 0,
    tick: 0,
    requestedIds: [],
    authorization: null,
    queries: [],
  };
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    state.authorization = request.headers.authorization || null;
    if (url.pathname === '/v2/price_feeds') {
      state.catalogRequests += 1;
      state.catalogLimits.push(url.searchParams.get('limit'));
      state.queries.push(url.searchParams.get('query') || '');
      if (state.failCatalog > 0) { state.failCatalog -= 1; return json(response, 503, { error: 'temporary outage' }); }
      const query = (url.searchParams.get('query') || '').toLowerCase();
      const assetType = url.searchParams.get('asset_type') || '';
      const rows = FEED_ROWS.filter((row) => {
        const attributes = row.attributes;
        const matchesQuery = !query || `${attributes.symbol} ${attributes.description} ${attributes.base}`.toLowerCase().includes(query);
        return matchesQuery && (!assetType || attributes.asset_type === assetType);
      });
      return json(response, 200, rows);
    }
    if (url.pathname === '/v2/updates/price/latest') {
      state.priceRequests += 1;
      if (state.failPrices > 0) { state.failPrices -= 1; return json(response, 503, { error: 'temporary outage' }); }
      const ids = url.searchParams.getAll('ids[]').map((id) => id.toLowerCase().replace(/^0x/, ''));
      state.requestedIds.push(ids);
      state.tick += 1;
      const parsed = [];
      for (const id of ids) {
        const row = FEED_ROWS.find((item) => item.id === id);
        if (!row) continue;
        const base = BASE_PRICES[row.attributes.symbol] || '25000000000';
        const price = (BigInt(base) + BigInt(state.tick - 1)).toString();
        parsed.push({
          id,
          price: { price, conf: '1250000000', expo: -8, publish_time: 1760000000 + state.tick },
          ema_price: { price: (BigInt(price) - 1000n).toString(), conf: '1300000000', expo: -8, publish_time: 1760000000 + state.tick },
          metadata: { slot: 123456 + state.tick, proof_available: true },
        });
      }
      return json(response, 200, { binary: { encoding: 'hex', data: [] }, parsed });
    }
    return json(response, 404, { error: 'not found' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    state,
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function testEnv(root, baseUrl) {
  return {
    ...process.env,
    PYTH_ROOT: root,
    PYTH_BASE_URL: baseUrl,
    PYTH_RETRIES: '0',
    PYTH_TIMEOUT_MS: '3000',
  };
}

module.exports = { createMockPythServer, testEnv, FEED_ROWS, BASE_PRICES };
