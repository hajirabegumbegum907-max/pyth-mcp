'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DEFAULT_CONFIG } = require('./constants');
const { ConfigError } = require('./errors');
const { isObject } = require('./validation');

const CONFIG_DIR = '.pyth-mcp';
const CONFIG_FILE = 'config.json';
const CACHE_FILE = 'cache.json';
const CONFIG_KEYS = Object.freeze(['baseUrl', 'apiKey', 'timeoutMs', 'cacheTtlMs', 'catalogTtlMs', 'retries']);
const KEY_ALIASES = Object.freeze({
  'base-url': 'baseUrl',
  'api-key': 'apiKey',
  'timeout-ms': 'timeoutMs',
  'cache-ttl-ms': 'cacheTtlMs',
  'catalog-ttl-ms': 'catalogTtlMs',
});

function canonicalKey(key) {
  const normalized = KEY_ALIASES[key] || key;
  if (!CONFIG_KEYS.includes(normalized)) throw new ConfigError(`Unknown configuration key: ${key}`);
  return normalized;
}

function validateBaseUrl(value) {
  if (typeof value !== 'string' || !value.trim()) throw new ConfigError('baseUrl must be a non-empty string');
  let url;
  try { url = new URL(value); } catch { throw new ConfigError('baseUrl must be a valid absolute URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new ConfigError('baseUrl must use HTTP or HTTPS');
  if (url.username || url.password) throw new ConfigError('baseUrl must not contain credentials');
  if (url.search || url.hash) throw new ConfigError('baseUrl must not contain a query string or fragment');
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/+$/, '');
}

function validateValue(key, value) {
  const canonical = canonicalKey(key);
  if (canonical === 'baseUrl') return validateBaseUrl(value);
  if (canonical === 'apiKey') {
    if (typeof value !== 'string' || value.length > 512) throw new ConfigError('apiKey must be a string of at most 512 characters');
    return value.trim();
  }
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (!Number.isInteger(number)) throw new ConfigError(`${canonical} must be an integer`);
  const limits = {
    timeoutMs: [100, 120000],
    cacheTtlMs: [0, 86400000],
    catalogTtlMs: [0, 604800000],
    retries: [0, 5],
  };
  const [minimum, maximum] = limits[canonical];
  if (number < minimum || number > maximum) throw new ConfigError(`${canonical} must be between ${minimum} and ${maximum}`);
  return number;
}

function validateConfig(value) {
  if (!isObject(value)) throw new ConfigError('Configuration must be a JSON object');
  for (const key of Object.keys(value)) canonicalKey(key);
  const result = {};
  for (const [key, child] of Object.entries(value)) result[canonicalKey(key)] = validateValue(key, child);
  return result;
}

function resolvePaths(options = {}) {
  const env = options.env || process.env;
  const rootDir = path.resolve(options.rootDir || env.PYTH_ROOT || process.cwd());
  const stateDir = path.join(rootDir, CONFIG_DIR);
  return {
    rootDir,
    stateDir,
    configPath: path.join(stateDir, CONFIG_FILE),
    cachePath: path.join(stateDir, CACHE_FILE),
  };
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

function loadConfig(options = {}) {
  const env = options.env || process.env;
  const paths = resolvePaths(options);
  let fileConfig = {};
  if (fs.existsSync(paths.configPath)) {
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(paths.configPath, 'utf8')); }
    catch (error) { throw new ConfigError(`Cannot parse ${paths.configPath}: ${error.message}`); }
    fileConfig = validateConfig(parsed);
  }
  const environmentConfig = {};
  const environmentKeys = {
    PYTH_BASE_URL: 'baseUrl',
    PYTH_API_KEY: 'apiKey',
    PYTH_TIMEOUT_MS: 'timeoutMs',
    PYTH_CACHE_TTL_MS: 'cacheTtlMs',
    PYTH_CATALOG_TTL_MS: 'catalogTtlMs',
    PYTH_RETRIES: 'retries',
  };
  for (const [environmentKey, configKey] of Object.entries(environmentKeys)) {
    if (env[environmentKey] !== undefined && env[environmentKey] !== '') {
      environmentConfig[configKey] = validateValue(configKey, env[environmentKey]);
    }
  }
  const overrides = validateConfig(options.overrides || {});
  return {
    ...DEFAULT_CONFIG,
    ...fileConfig,
    ...environmentConfig,
    ...overrides,
    ...paths,
  };
}

function initConfig(options = {}) {
  const config = loadConfig(options);
  const created = [];
  if (!fs.existsSync(config.stateDir)) {
    fs.mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
    created.push(config.stateDir);
  }
  if (!fs.existsSync(config.configPath)) {
    const fileValues = {};
    for (const key of CONFIG_KEYS) fileValues[key] = DEFAULT_CONFIG[key];
    atomicWriteJson(config.configPath, fileValues);
    created.push(config.configPath);
  }
  return { config, created };
}

function saveConfig(patch, options = {}) {
  const config = loadConfig(options);
  const validated = validateConfig(patch);
  let current = {};
  if (fs.existsSync(config.configPath)) {
    try { current = JSON.parse(fs.readFileSync(config.configPath, 'utf8')); }
    catch (error) { throw new ConfigError(`Cannot parse ${config.configPath}: ${error.message}`); }
  }
  const next = { ...DEFAULT_CONFIG, ...validateConfig(current), ...validated };
  const fileValues = {};
  for (const key of CONFIG_KEYS) fileValues[key] = next[key];
  atomicWriteJson(config.configPath, fileValues);
  return loadConfig(options);
}

function resetConfig(options = {}) {
  const config = loadConfig(options);
  const fileValues = {};
  for (const key of CONFIG_KEYS) fileValues[key] = DEFAULT_CONFIG[key];
  atomicWriteJson(config.configPath, fileValues);
  return loadConfig(options);
}

function publicConfig(config) {
  const result = {};
  for (const key of CONFIG_KEYS) result[key] = key === 'apiKey' && config.apiKey ? '[redacted]' : config[key];
  return { ...result, rootDir: config.rootDir, configPath: config.configPath, cachePath: config.cachePath };
}

module.exports = {
  CONFIG_DIR,
  CONFIG_FILE,
  CACHE_FILE,
  CONFIG_KEYS,
  canonicalKey,
  validateBaseUrl,
  validateValue,
  validateConfig,
  resolvePaths,
  atomicWriteJson,
  loadConfig,
  initConfig,
  saveConfig,
  resetConfig,
  publicConfig,
};
