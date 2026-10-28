'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMockPythServer, testEnv } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'cli.js');
let mock;
let root;

test.before(async () => { mock = await createMockPythServer(); });
test.after(async () => { if (mock) await mock.close(); });
test.beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pyth-cli-test-'));
  mock.state.tick = 0;
});
test.afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function cli(args, options = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      env: testEnv(root, mock.url),
      encoding: 'utf8',
      timeout: options.timeout || 15000,
      maxBuffer: 8 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      resolve({ status: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr });
    });
  });
}

async function cliJson(args) {
  const result = await cli(args);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('help and version expose all required commands', async () => {
  const help = await cli(['--help']);
  assert.equal(help.status, 0);
  for (const command of ['init', 'config', 'list-prices', 'get-price', 'watch', 'mcp-start']) assert.match(help.stdout, new RegExp(command));
  const version = await cli(['--version']);
  assert.equal(version.stdout.trim(), '1.0.0');
});

test('init creates a project-local state directory', async () => {
  const result = await cliJson(['init', '--json']);
  assert.equal(result.initialized, true);
  assert.equal(result.created.length, 2);
  assert.ok(fs.existsSync(path.join(root, '.pyth-mcp', 'config.json')));
});

test('config set, get, and reset operate through the CLI', async () => {
  let result = await cliJson(['config', 'set', 'cacheTtlMs', '45000', '--json']);
  assert.equal(result.cacheTtlMs, 45000);
  result = await cliJson(['config', 'get', 'cacheTtlMs', '--json']);
  assert.deepEqual(result, { cacheTtlMs: 45000 });
  result = await cliJson(['config', 'reset', '--json']);
  assert.equal(result.cacheTtlMs, 30000);
});

test('list-prices searches the feed catalog', async () => {
  const result = await cliJson(['list-prices', 'BTC', '--json']);
  assert.equal(result.feeds[0].symbol, 'Crypto.BTC/USD');
  assert.equal(result.returned, 1);
});

test('get-price resolves a symbol and uses cache on the second invocation', async () => {
  const first = await cliJson(['get-price', 'BTC/USD', '--json']);
  assert.equal(first.price, 67000.25);
  assert.equal(first.cached, false);
  const second = await cliJson(['get-price', 'BTC/USD', '--json']);
  assert.equal(second.cached, true);
});

test('get-price accepts comma-separated batch feeds', async () => {
  const result = await cliJson(['get-price', 'BTC/USD,ETH/USD', '--json']);
  assert.equal(result.count, 2);
  assert.deepEqual(result.prices.map((quote) => quote.symbol), ['Crypto.BTC/USD', 'Crypto.ETH/USD']);
});

test('watch emits the requested number of fresh JSON lines', async () => {
  const result = await cli(['watch', 'SOL/USD', '--interval', '250', '--count', '2', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.ok(lines.every((quote) => quote.symbol === 'Crypto.SOL/USD' && quote.cached === false));
  assert.notEqual(lines[0].raw.price, lines[1].raw.price);
});

test('invalid options and domain failures use distinct exit codes', async () => {
  const invalid = await cli(['get-price', 'BTC/USD', '--cache-ttl', '-1']);
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /--cache-ttl/);
  const missing = await cli(['get-price', 'NOT-A-FEED', '--json']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /No Pyth price feed/);
});

test('numeric CLI options reject non-decimal and fractional forms', async () => {
  for (const value of ['1e2', '1.5', '0x10', '']) {
    const result = await cli(['list-prices', '--limit', value]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--limit/);
  }
});

test('unknown configuration keys are reported explicitly', async () => {
  const result = await cli(['config', 'get', 'noSuchKey', '--json']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown configuration key: noSuchKey/);
});

test('MCP startup failures omit stack traces', async () => {
  fs.mkdirSync(path.join(root, '.pyth-mcp'), { recursive: true });
  fs.writeFileSync(path.join(root, '.pyth-mcp', 'config.json'), '{broken');
  const result = await new Promise((resolve) => {
    execFile(process.execPath, ['mcp-server.js'], {
      cwd: ROOT, env: testEnv(root, mock.url), encoding: 'utf8', timeout: 15000,
    }, (error, stdout, stderr) => resolve({ status: error ? 1 : 0, stdout, stderr }));
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\[pyth-mcp\] fatal: Cannot parse/);
  assert.doesNotMatch(result.stderr, /\n\s+at\s/);
});
