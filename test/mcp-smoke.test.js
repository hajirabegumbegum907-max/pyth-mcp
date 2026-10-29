'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMockPythServer, testEnv } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let nextId = 0;
const id = () => ++nextId;

function startServer(root, baseUrl, viaCli = false) {
  const child = spawn(process.execPath, viaCli ? ['bin/cli.js', 'mcp-start'] : ['mcp-server.js'], {
    cwd: ROOT,
    env: testEnv(root, baseUrl),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const responses = [];
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) {
        try { responses.push(JSON.parse(line)); }
        catch { responses.push({ parseError: line }); }
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`));
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const sendRaw = (text) => child.stdin.write(`${text}\n`);
  const waitFor = (predicate, timeout = 10000) => new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const hit = responses.find(predicate);
      if (hit) return resolve(hit);
      if (Date.now() - start > timeout) return reject(new Error('MCP response timeout'));
      setTimeout(tick, 20);
    };
    tick();
  });
  const stop = () => new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', resolve);
    child.stdin.end();
  });
  return { child, responses, send, sendRaw, waitFor, stop };
}

function initialize(server, protocolVersion = '2025-06-18') {
  const requestId = id();
  server.send({ jsonrpc: '2.0', id: requestId, method: 'initialize', params: {
    protocolVersion,
    capabilities: {},
    clientInfo: { name: 'smoke', version: '1.0.0' },
  } });
  return server.waitFor((message) => message.id === requestId);
}

test('MCP stdio server implements the protocol and Pyth tools end to end', async () => {
  const mock = await createMockPythServer();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pyth-mcp-test-'));
  const checks = [];
  const servers = [];
  const expect = (name, condition, detail) => {
    checks.push({ name, ok: Boolean(condition) });
    if (!condition) process.stderr.write(`FAIL ${name}${detail ? `: ${detail}` : ''}\n`);
  };
  const text = (response) => response.result?.content?.[0]?.text || '';
  const parsed = (response) => { try { return JSON.parse(text(response)); } catch { return null; } };
  try {
    const server = startServer(root, mock.url);
    servers.push(server);
    const call = async (name, args = {}) => {
      const requestId = id();
      server.send({ jsonrpc: '2.0', id: requestId, method: 'tools/call', params: { name, arguments: args } });
      return server.waitFor((message) => message.id === requestId);
    };

    const initialized = await initialize(server);
    expect('initialize negotiates protocol and serverInfo', initialized.result?.protocolVersion === '2025-06-18'
      && initialized.result?.serverInfo.name === 'pyth-mcp');
    const duplicateInitialize = await initialize(server);
    expect('duplicate initialize is rejected with -32600', duplicateInitialize.error?.code === -32600
      && /already initialized/.test(duplicateInitialize.error.message));
    const notificationStart = server.responses.length;
    server.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    server.send({ jsonrpc: '2.0', method: 'ping' });
    server.send({ jsonrpc: '2.0', method: 'tools/list' });
    await sleep(200);
    expect('notifications receive no responses', server.responses.length === notificationStart);

    const pingId = id();
    server.send({ jsonrpc: '2.0', id: pingId, method: 'ping' });
    const ping = await server.waitFor((message) => message.id === pingId);
    expect('ping returns an empty result', ping.result && Object.keys(ping.result).length === 0);
    const listId = id();
    server.send({ jsonrpc: '2.0', id: listId, method: 'tools/list' });
    const list = await server.waitFor((message) => message.id === listId);
    const tools = list.result.tools;
    expect('exactly seven tools are exposed', tools.length === 7, tools.map((tool) => tool.name).join(','));
    expect('all tool schemas are closed input objects', tools.every((tool) => tool.description
      && tool.inputSchema.type === 'object' && tool.inputSchema.additionalProperties === false));

    let response = await call('pyth_list_feeds', { query: 'BTC' });
    expect('list_feeds searches the live catalog', parsed(response)?.feeds[0]?.symbol === 'Crypto.BTC/USD', text(response));
    response = await call('pyth_resolve_feed', { feed: 'ETH/USD' });
    expect('resolve_feed returns canonical metadata', parsed(response)?.symbol === 'Crypto.ETH/USD');
    response = await call('pyth_get_price', { feed: 'BTC/USD' });
    expect('get_price returns price and confidence', parsed(response)?.price === 67000.25
      && parsed(response)?.confidence === 12.5, text(response));
    response = await call('pyth_get_price', { feed: 'BTC/USD' });
    expect('second get_price uses the TTL cache', parsed(response)?.cached === true);
    response = await call('pyth_get_prices', { feeds: ['BTC/USD', 'ETH/USD'] });
    expect('get_prices returns a batch with per-feed cache state', parsed(response)?.count === 2
      && parsed(response)?.prices[0]?.cached === true && parsed(response)?.prices[1]?.cached === false);
    response = await call('pyth_get_prices', { feeds: ['BTC/USD', 'b'.repeat(64)] });
    expect('get_prices returns partial successes and structured errors', parsed(response)?.count === 1
      && parsed(response)?.errorCount === 1 && parsed(response)?.errors[0]?.code === 'PRICE_NOT_FOUND');
    response = await call('pyth_get_price', { feed: 'BTC/USD', force_refresh: true });
    expect('force_refresh bypasses the cache', parsed(response)?.cached === false);
    response = await call('pyth_ping');
    expect('ping tool checks Hermes reachability', parsed(response)?.status === 'ok');

    response = await call('pyth_get_price', { feed: 'BTC/USD', unexpected: true });
    expect('additional properties are rejected with -32602', response.error?.code === -32602);
    response = await call('pyth_get_prices', { feeds: [] });
    expect('empty feeds are rejected with -32602', response.error?.code === -32602);
    response = await call('pyth_get_price', { feed: 'BTC/USD', cache_ttl: 86401 });
    expect('cache TTL maximum is enforced', response.error?.code === -32602);
    response = await call('pyth_get_price', { feed: 'NOT-A-FEED' });
    expect('unknown feed returns a domain error result', response.result?.isError === true && text(response).includes('FEED_NOT_FOUND'));
    response = await call('not_a_tool', {});
    expect('unknown tool returns -32602', response.error?.code === -32602);

    const batchStart = server.responses.length;
    server.send([{ jsonrpc: '2.0', id: id(), method: 'ping' }]);
    await sleep(200);
    const batch = server.responses.slice(batchStart)[0];
    expect('latest protocol rejects batch requests', batch?.error?.code === -32600 && /batching/.test(batch.error.message));
    server.sendRaw('{bad json');
    const parseError = await server.waitFor((message) => message.error?.code === -32700);
    expect('malformed JSON returns -32700', Boolean(parseError));
    server.sendRaw('{}');
    const malformed = await server.waitFor((message) => message.error?.code === -32600 && /jsonrpc/.test(message.error.message));
    expect('malformed Request returns -32600', Boolean(malformed));
    expect('stdout contains only valid JSON messages', !server.responses.some((message) => message.parseError));
    await server.stop();

    const legacy = startServer(root, mock.url, true);
    servers.push(legacy);
    const negotiated = await initialize(legacy, '2025-03-26');
    expect('CLI MCP server negotiates an older protocol', negotiated.result?.protocolVersion === '2025-03-26');
    legacy.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const legacyBatchId = id();
    legacy.send([{ jsonrpc: '2.0', id: legacyBatchId, method: 'ping' }]);
    const legacyBatch = await legacy.waitFor((message) => Array.isArray(message) && message[0]?.id === legacyBatchId);
    expect('older protocol receives a batch array response', Array.isArray(legacyBatch) && Boolean(legacyBatch[0].result));
    const notificationBatchStart = legacy.responses.length;
    legacy.send([{ jsonrpc: '2.0', method: 'notifications/initialized' }]);
    await sleep(200);
    expect('notification-only legacy batch emits no empty array', legacy.responses.length === notificationBatchStart);
    await legacy.stop();

    const earlyServer = startServer(root, mock.url);
    servers.push(earlyServer);
    const earlyId = id();
    earlyServer.send({ jsonrpc: '2.0', id: earlyId, method: 'ping' });
    const early = await earlyServer.waitFor((message) => message.id === earlyId);
    expect('request before initialize returns -32002', early.error?.code === -32002);
    const emptyId = id();
    earlyServer.send({ jsonrpc: '2.0', id: emptyId, method: 'initialize', params: {} });
    const empty = await earlyServer.waitFor((message) => message.id === emptyId);
    expect('empty initialize returns -32602', empty.error?.code === -32602);
    await earlyServer.stop();

    const oversized = startServer(root, mock.url);
    servers.push(oversized);
    await initialize(oversized);
    oversized.child.stdin.write('x'.repeat(1100001));
    const overflow = await oversized.waitFor((message) => /maximum stdin line size/.test(message.error?.message || ''));
    expect('stdin buffer is bounded', overflow.error?.code === -32600);
    oversized.child.stdin.write('\n');
    const afterOverflowId = id();
    oversized.send({ jsonrpc: '2.0', id: afterOverflowId, method: 'ping' });
    const recovered = await oversized.waitFor((message) => message.id === afterOverflowId);
    expect('server recovers after an oversized line', Boolean(recovered.result));
    await oversized.stop();
  } finally {
    await Promise.all(servers.map((server) => server.stop()));
    await mock.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
  for (const check of checks) console.log(`${check.ok ? 'PASS' : 'FAIL'} ${check.name}`);
  console.log(`RESULT ${checks.filter((check) => check.ok).length}/${checks.length} checks passed`);
  assert.equal(checks.every((check) => check.ok), true);
});
