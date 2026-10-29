'use strict';

const object = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const feed = { type: 'string', minLength: 1, maxLength: 128 };
const forceRefresh = { type: 'boolean' };
const allowStale = { type: 'boolean' };
const cacheTtl = { type: 'integer', minimum: 0, maximum: 86400 };

const TOOLS = Object.freeze([
  {
    name: 'pyth_get_price',
    description: 'Get the latest Pyth price, confidence interval, EMA price, exponent, publish time, and staleness for one symbol or feed id.',
    inputSchema: object({ feed, force_refresh: forceRefresh, allow_stale: allowStale, cache_ttl: cacheTtl }, ['feed']),
  },
  {
    name: 'pyth_get_prices',
    description: 'Get latest Pyth prices for up to 100 symbols or feed ids, using independent per-feed cache entries.',
    inputSchema: object({
      feeds: { type: 'array', items: feed, minItems: 1, maxItems: 100, uniqueItems: true },
      force_refresh: forceRefresh,
      allow_stale: allowStale,
      cache_ttl: cacheTtl,
    }, ['feeds']),
  },
  {
    name: 'pyth_get_price_history',
    description: 'Return the in-memory price history recorded during this session for one symbol or feed id, newest last.',
    inputSchema: object({ feed, limit: { type: 'integer', minimum: 1, maximum: 5000 } }, ['feed']),
  },
  {
    name: 'pyth_list_feeds',
    description: 'Search the Pyth Hermes price feed catalog by symbol or description, with a one-hour catalog cache by default.',
    inputSchema: object({
      query: { type: 'string', maxLength: 128 },
      asset_type: { type: 'string', pattern: '^[a-zA-Z][a-zA-Z0-9_-]{0,31}$' },
      limit: { type: 'integer', minimum: 1, maximum: 1000 },
      force_refresh: forceRefresh,
    }),
  },
  {
    name: 'pyth_resolve_feed',
    description: 'Resolve a symbol such as BTC/USD or a 64-character hexadecimal id to canonical Pyth feed metadata.',
    inputSchema: object({ feed }, ['feed']),
  },
  {
    name: 'pyth_stream_prices',
    description: 'Stream live Pyth price updates from the Hermes streaming endpoint for up to 100 feeds, collecting updates for a bounded duration.',
    inputSchema: object({
      feeds: { type: 'array', items: feed, minItems: 1, maxItems: 100, uniqueItems: true },
      duration_ms: { type: 'integer', minimum: 1000, maximum: 300000 },
      max_updates: { type: 'integer', minimum: 1, maximum: 1000 },
      threshold: { type: 'integer', minimum: 0, maximum: 100 },
    }, ['feeds']),
  },
  {
    name: 'pyth_ping',
    description: 'Check Pyth Hermes API reachability with a small live feed catalog request.',
    inputSchema: object(),
  },
]);

async function callTool(client, name, args) {
  switch (name) {
    case 'pyth_get_price':
      return client.getPrice(args.feed, {
        forceRefresh: args.force_refresh === true,
        allowStale: args.allow_stale === true,
        cacheTtlMs: args.cache_ttl === undefined ? undefined : args.cache_ttl * 1000,
      });
    case 'pyth_get_prices':
      return client.getPrices(args.feeds, {
        forceRefresh: args.force_refresh === true,
        allowStale: args.allow_stale === true,
        cacheTtlMs: args.cache_ttl === undefined ? undefined : args.cache_ttl * 1000,
      });
    case 'pyth_get_price_history':
      return client.getPriceHistory(args.feed, { limit: args.limit });
    case 'pyth_list_feeds':
      return client.listFeeds({
        query: args.query,
        assetType: args.asset_type,
        limit: args.limit,
        forceRefresh: args.force_refresh === true,
      });
    case 'pyth_resolve_feed': return client.resolveFeed(args.feed);
    case 'pyth_stream_prices':
      return client.streamPrices(args.feeds, {
        durationMs: args.duration_ms,
        maxUpdates: args.max_updates,
        threshold: args.threshold,
      });
    case 'pyth_ping': return client.ping();
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

module.exports = { TOOLS, callTool };
