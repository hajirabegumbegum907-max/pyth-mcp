'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { initConfig, loadConfig, saveConfig, resetConfig, publicConfig } = require('../lib/config');
const { TTLCache } = require('../lib/cache');

let root;
test.beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'pyth-config-test-')); });
test.afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

test('init creates configuration and remains idempotent', () => {
  const first = initConfig({ rootDir: root });
  assert.equal(first.created.length, 2);
  assert.ok(fs.existsSync(first.config.configPath));
  const second = initConfig({ rootDir: root });
  assert.equal(second.created.length, 0);
  assert.equal(second.config.baseUrl, 'https://hermes.pyth.network');
});

test('configuration supports updates, aliases, and reset', () => {
  saveConfig({ 'cache-ttl-ms': '45000', retries: 3 }, { rootDir: root });
  let config = loadConfig({ rootDir: root });
  assert.equal(config.cacheTtlMs, 45000);
  assert.equal(config.retries, 3);
  config = resetConfig({ rootDir: root });
  assert.equal(config.cacheTtlMs, 30000);
  assert.equal(config.retries, 2);
});

test('init followed by repeated saves preserves existing configuration', () => {
  initConfig({ rootDir: root });
  saveConfig({ retries: 1 }, { rootDir: root });
  saveConfig({ timeoutMs: 5000 }, { rootDir: root });
  saveConfig({ cacheTtlMs: 45000 }, { rootDir: root });
  const config = loadConfig({ rootDir: root });
  assert.equal(config.retries, 1);
  assert.equal(config.timeoutMs, 5000);
  assert.equal(config.cacheTtlMs, 45000);
});

test('environment and explicit overrides have the correct precedence', () => {
  saveConfig({ timeoutMs: 4000 }, { rootDir: root });
  const config = loadConfig({
    rootDir: root,
    env: { PYTH_TIMEOUT_MS: '5000', PYTH_CACHE_TTL_MS: '0' },
    overrides: { timeoutMs: 6000 },
  });
  assert.equal(config.timeoutMs, 6000);
  assert.equal(config.cacheTtlMs, 0);
});

test('invalid configuration is rejected with clear errors', () => {
  assert.throws(() => saveConfig({ unknown: 1 }, { rootDir: root }), /Unknown configuration key/);
  assert.throws(() => saveConfig({ baseUrl: 'ftp://example.com' }, { rootDir: root }), /HTTP or HTTPS/);
  assert.throws(() => saveConfig({ baseUrl: 'https://user:pass@example.com' }, { rootDir: root }), /credentials/);
  assert.throws(() => saveConfig({ retries: 6 }, { rootDir: root }), /between 0 and 5/);
});

test('public configuration exposes no internal state beyond local paths', () => {
  const config = publicConfig(loadConfig({ rootDir: root }));
  assert.deepEqual(Object.keys(config).sort(), [
    'baseUrl', 'apiKey', 'cachePath', 'cacheTtlMs', 'catalogTtlMs', 'configPath', 'retries', 'rootDir', 'timeoutMs',
  ].sort());
});

test('public configuration redacts API keys', () => {
  saveConfig({ apiKey: 'secret-value' }, { rootDir: root });
  const config = publicConfig(loadConfig({ rootDir: root }));
  assert.equal(config.apiKey, '[redacted]');
  assert.equal(JSON.stringify(config).includes('secret-value'), false);
});

test('TTL cache expires entries and persists them on disk', () => {
  let now = 1000;
  const filePath = path.join(root, 'cache.json');
  const cache = new TTLCache({ filePath, now: () => now });
  cache.set('key', { value: 42 });
  assert.deepEqual(cache.get('key', 100), { value: 42 });
  now += 101;
  assert.equal(cache.get('key', 100), undefined);
  assert.equal(cache.peek('key'), undefined);
  cache.set('persistent', { value: 42 });
  cache.close();
  const restored = new TTLCache({ filePath, now: () => now });
  assert.deepEqual(restored.peek('persistent'), { value: 42 });
  restored.clear();
  assert.equal(restored.size, 0);
  restored.close();
});

test('cache prunes expired entries during subsequent writes', () => {
  let now = 1000;
  const cache = new TTLCache({ filePath: path.join(root, 'cache.json'), now: () => now, flushDelayMs: 1000 });
  cache.set('expired', 'old', 50);
  now += 51;
  cache.set('fresh', 'new', 50);
  assert.equal(cache.peek('expired'), undefined);
  assert.equal(cache.size, 1);
  cache.close();
});

test('cache enforces entry count and serialized size limits', () => {
  const countLimited = new TTLCache({ filePath: path.join(root, 'count.json'), maxEntries: 2, flushDelayMs: 1000 });
  countLimited.set('first', '1');
  countLimited.set('second', '2');
  countLimited.set('third', '3');
  assert.equal(countLimited.size, 2);
  assert.equal(countLimited.peek('first'), undefined);
  countLimited.close();
  const sizeLimited = new TTLCache({ filePath: path.join(root, 'size.json'), maxBytes: 500, flushDelayMs: 1000 });
  sizeLimited.set('large', 'x'.repeat(2000));
  assert.equal(sizeLimited.size, 0);
  sizeLimited.close();
  assert.ok(fs.statSync(path.join(root, 'size.json')).size <= 500);
});

test('cache batches repeated writes until flush or close', () => {
  const filePath = path.join(root, 'batch.json');
  const cache = new TTLCache({ filePath, flushDelayMs: 10000 });
  cache.set('first', 1);
  cache.set('second', 2);
  cache.set('third', 3);
  assert.equal(fs.existsSync(filePath), false);
  cache.close();
  assert.equal(fs.existsSync(filePath), true);
  const restored = new TTLCache({ filePath });
  assert.equal(restored.size, 3);
  restored.close();
});

test('corrupt cache files are quarantined and the cache self-heals', () => {
  const filePath = path.join(root, 'cache.json');
  fs.writeFileSync(filePath, '{broken');
  const cache = new TTLCache({ filePath });
  assert.equal(cache.peek('key'), undefined);
  assert.equal(cache.size, 0);
  cache.set('fresh', 'value');
  cache.close();
  const files = fs.readdirSync(root).filter((name) => name.startsWith('cache.json.corrupt-'));
  assert.equal(files.length, 1);
  const recovered = new TTLCache({ filePath });
  assert.equal(recovered.peek('fresh'), 'value');
  recovered.close();
});

test('cache recovers from invalid format without failing', () => {
  const filePath = path.join(root, 'cache.json');
  fs.writeFileSync(filePath, '{"version":99,"entries":{}}');
  const cache = new TTLCache({ filePath });
  assert.equal(cache.size, 0);
  cache.close();
  assert.ok(fs.readdirSync(root).some((name) => name.startsWith('cache.json.corrupt-')));
});

test('get without an explicit ttl consults the cache default ttl', () => {
  let now = 1000;
  const cache = new TTLCache({ filePath: path.join(root, 'default-ttl.json'), now: () => now, defaultTtlMs: 100, flushDelayMs: 1000 });
  cache.set('key', 'value');
  assert.equal(cache.get('key'), 'value');
  now += 101;
  assert.equal(cache.get('key'), undefined);
  cache.close();
});

test('get with an explicit zero ttl always misses', () => {
  let now = 1000;
  const cache = new TTLCache({ filePath: path.join(root, 'zero-ttl.json'), now: () => now, flushDelayMs: 1000 });
  cache.set('key', 'value');
  assert.equal(cache.get('key', 0), undefined);
  cache.close();
});

test('package has no runtime dependencies or install scripts', () => {
  const pkg = require('../package.json');
  assert.equal(pkg.dependencies, undefined);
  for (const script of ['preinstall', 'install', 'postinstall', 'prepare']) assert.equal(pkg.scripts[script], undefined);
});
