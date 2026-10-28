'use strict';

const { PythClient, normalizeFeed, normalizePriceUpdate, decimalValue } = require('./lib/client');
const { TTLCache } = require('./lib/cache');
const {
  loadConfig,
  initConfig,
  saveConfig,
  resetConfig,
  publicConfig,
} = require('./lib/config');
const { MAJOR_FEEDS, DEFAULT_CONFIG, PROTOCOL_VERSION, SUPPORTED_VERSIONS } = require('./lib/constants');
const { PythError, ConfigError, ValidationError } = require('./lib/errors');
const { startMcpServer } = require('./mcp-server');

module.exports = {
  PythClient,
  TTLCache,
  normalizeFeed,
  normalizePriceUpdate,
  decimalValue,
  loadConfig,
  initConfig,
  saveConfig,
  resetConfig,
  publicConfig,
  MAJOR_FEEDS,
  DEFAULT_CONFIG,
  PROTOCOL_VERSION,
  SUPPORTED_VERSIONS,
  PythError,
  ConfigError,
  ValidationError,
  startMcpServer,
};
