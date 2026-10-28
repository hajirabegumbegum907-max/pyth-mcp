'use strict';

const PACKAGE_NAME = 'pyth-mcp';
const PACKAGE_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_VERSIONS = Object.freeze(['2025-06-18', '2025-03-26', '2024-11-05']);
const DEFAULT_BASE_URL = 'https://hermes.pyth.network';
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_CACHE_TTL_MS = 30000;
const DEFAULT_CATALOG_TTL_MS = 3600000;
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_BACKOFF_MS = 250;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_STDIN_BUFFER = 1100000;
const MAX_FEEDS_PER_REQUEST = 100;

const MAJOR_FEEDS = Object.freeze([
  Object.freeze({
    id: 'e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
    symbol: 'Crypto.BTC/USD',
    base: 'BTC',
    quoteCurrency: 'USD',
    assetType: 'crypto',
    name: 'Bitcoin / US Dollar',
  }),
  Object.freeze({
    id: 'ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
    symbol: 'Crypto.ETH/USD',
    base: 'ETH',
    quoteCurrency: 'USD',
    assetType: 'crypto',
    name: 'Ethereum / US Dollar',
  }),
  Object.freeze({
    id: 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
    symbol: 'Crypto.SOL/USD',
    base: 'SOL',
    quoteCurrency: 'USD',
    assetType: 'crypto',
    name: 'Solana / US Dollar',
  }),
  Object.freeze({
    id: 'eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a',
    symbol: 'Crypto.USDC/USD',
    base: 'USDC',
    quoteCurrency: 'USD',
    assetType: 'crypto',
    name: 'USD Coin / US Dollar',
  }),
  Object.freeze({
    id: '2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b',
    symbol: 'Crypto.USDT/USD',
    base: 'USDT',
    quoteCurrency: 'USD',
    assetType: 'crypto',
    name: 'Tether USD / US Dollar',
  }),
]);

const DEFAULT_CONFIG = Object.freeze({
  baseUrl: DEFAULT_BASE_URL,
  apiKey: '',
  timeoutMs: DEFAULT_TIMEOUT_MS,
  cacheTtlMs: DEFAULT_CACHE_TTL_MS,
  catalogTtlMs: DEFAULT_CATALOG_TTL_MS,
  retries: DEFAULT_RETRIES,
});

module.exports = {
  PACKAGE_NAME,
  PACKAGE_VERSION,
  PROTOCOL_VERSION,
  SUPPORTED_VERSIONS,
  DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_CATALOG_TTL_MS,
  DEFAULT_RETRIES,
  DEFAULT_RETRY_BACKOFF_MS,
  MAX_RESPONSE_BYTES,
  MAX_STDIN_BUFFER,
  MAX_FEEDS_PER_REQUEST,
  MAJOR_FEEDS,
  DEFAULT_CONFIG,
};
