'use strict';

const { PythClient, normalizeFeed, normalizePriceUpdate, decimalValue, parseRetryAfter } = require('./lib/client');
const { TTLCache } = require('./lib/cache');
const {
  loadConfig,
  initConfig,
  saveConfig,
  resetConfig,
  publicConfig,
} = require('./lib/config');
const { MAJOR_FEEDS, DEFAULT_CONFIG, PROTOCOL_VERSION, SUPPORTED_VERSIONS, PACKAGE_VERSION } = require('./lib/constants');
const { PythError, ConfigError, ValidationError } = require('./lib/errors');
const { streamPrices } = require('./lib/stream');
const { startMcpServer } = require('./mcp-server');

module.exports = {
  PythClient,
  TTLCache,
  normalizeFeed,
  normalizePriceUpdate,
  decimalValue,
  parseRetryAfter,
  loadConfig,
  initConfig,
  saveConfig,
  resetConfig,
  publicConfig,
  MAJOR_FEEDS,
  DEFAULT_CONFIG,
  PROTOCOL_VERSION,
  SUPPORTED_VERSIONS,
  PACKAGE_VERSION,
  streamPrices,
  PythError,
  ConfigError,
  ValidationError,
  startMcpServer,
};
