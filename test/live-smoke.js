'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PythClient } = require('../lib/client');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pyth-live-test-'));
  const client = new PythClient({ rootDir: root, overrides: { timeoutMs: 15000, retries: 1 } });
  try {
    const catalog = await client.listFeeds({ query: 'BTC/USD', limit: 10, forceRefresh: true });
    const feed = catalog.feeds.find((item) => item.symbol === 'Crypto.BTC/USD');
    assert.ok(feed, 'Live Hermes catalog did not contain Crypto.BTC/USD');
    if (!client.config.apiKey) {
      console.log(JSON.stringify({
        status: 'partial',
        network: 'live Hermes API',
        catalogCheck: 'passed',
        feed: feed.symbol,
        id: feed.id,
        priceCheck: 'skipped: set PYTH_API_KEY to test authenticated price updates',
      }, null, 2));
      console.log('RESULT 1/1 unauthenticated live catalog check passed; keyed price check skipped');
      return;
    }
    const quote = await client.getPrice('BTC/USD', { forceRefresh: true });
    assert.equal(quote.id, feed.id);
    assert.ok(quote.priceText && quote.confidenceText);
    assert.ok(Number.isInteger(quote.publishTime));
    console.log(JSON.stringify({
      status: 'ok',
      network: 'live Hermes API',
      feed: quote.symbol,
      id: quote.id,
      priceText: quote.priceText,
      confidenceText: quote.confidenceText,
      publishTimeIso: quote.publishTimeIso,
      cached: quote.cached,
    }, null, 2));
    console.log('RESULT 3/3 live checks passed');
  } finally {
    client.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
