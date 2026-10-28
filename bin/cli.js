#!/usr/bin/env node
'use strict';

const { PythClient } = require('../lib/client');
const { startMcpServer } = require('../mcp-server');
const { initConfig, loadConfig, saveConfig, resetConfig, publicConfig, canonicalKey } = require('../lib/config');

const USAGE = `pyth-mcp — Pyth Network Hermes price feeds and MCP server

Usage:
  pyth-mcp init [--root DIR] [--json]
  pyth-mcp config [get] [key] [--json]
  pyth-mcp config set <key> <value> [--json]
  pyth-mcp config reset [--json]
  pyth-mcp list-prices [query] [--asset-type crypto] [--limit N] [--force-refresh] [--json]
  pyth-mcp get-price <feed> [--force-refresh] [--cache-ttl SECONDS] [--json]
  pyth-mcp watch <feed> [--interval MS] [--count N] [--json]
  pyth-mcp mcp-start [--root DIR]

Feed references:
  Use BTC/USD, ETH/USD, SOL/USD, USDC/USD, USDT/USD, another catalog symbol,
  or a 64-character hexadecimal Pyth feed id. Comma-separated feeds are accepted
  by get-price for batch retrieval.

Configuration keys:
  baseUrl, apiKey, timeoutMs, cacheTtlMs, catalogTtlMs, retries

Global options:
  --root DIR          Project root containing .pyth-mcp (default: current directory)
  --json             Machine-readable output; watch emits one JSON object per line
  --force-refresh    Bypass cached data
  --cache-ttl N      Price cache TTL in seconds (default: 30)
  --interval N       Watch polling interval in milliseconds (default: 5000)
  --count N          Watch update count; 0 means run until interrupted
  --help             Show this usage
  --version          Print the package version
`;

const VALUE_FLAGS = new Set(['root', 'query', 'asset-type', 'limit', 'cache-ttl', 'interval', 'count']);
const BOOL_FLAGS = new Set(['json', 'force-refresh', 'refresh', 'help', 'version']);

function parse(argv) {
  const positional = [];
  const opts = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') { positional.push(...argv.slice(index + 1)); break; }
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    let key = arg.slice(2);
    let value;
    const equals = key.indexOf('=');
    if (equals >= 0) { value = key.slice(equals + 1); key = key.slice(0, equals); }
    if (BOOL_FLAGS.has(key)) {
      if (value !== undefined && !['true', 'false'].includes(value)) throw new Error(`--${key} expects true or false`);
      opts[key] = value === undefined ? true : value === 'true';
      continue;
    }
    if (!VALUE_FLAGS.has(key)) throw new Error(`unknown option --${key}`);
    if (value === undefined) {
      if (index + 1 >= argv.length) throw new Error(`--${key} requires a value`);
      value = argv[++index];
    }
    opts[key] = value;
  }
  return { positional, opts };
}

function print(value, opts, human) {
  if (opts.json || !human) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  else process.stdout.write(`${human(value)}\n`);
}

function priceLine(quote) {
  return `${quote.symbol || quote.id}  ${quote.priceText} +/- ${quote.confidenceText}  ${quote.publishTimeIso}${quote.cached ? '  (cached)' : ''}`;
}

function integerOption(value, name, minimum, maximum) {
  if ((typeof value !== 'string' && typeof value !== 'number') || !/^-?\d+$/.test(String(value))) {
    throw new Error(`${name} must be a base-10 integer`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return number;
}

async function withClient(opts, action) {
  const client = new PythClient({ rootDir: opts.root });
  try { return await action(client); }
  finally { client.close(); }
}

async function run(argv) {
  const { positional, opts } = parse(argv);
  const command = (positional[0] || '').toLowerCase();
  const rest = positional.slice(1);
  if (opts.version || command === 'version') { process.stdout.write(`${require('../package.json').version}\n`); return 0; }
  if (opts.help || !command || command === 'help') { process.stdout.write(USAGE); return 0; }

  switch (command) {
    case 'init': {
      const result = initConfig({ rootDir: opts.root });
      const output = { initialized: true, created: result.created, config: publicConfig(result.config) };
      print(output, opts, (value) => `Initialized ${value.config.stateDir}\nConfiguration: ${value.config.configPath}`);
      return 0;
    }
    case 'config': {
      const operation = rest[0] || 'get';
      if (operation === 'reset') {
        const output = publicConfig(resetConfig({ rootDir: opts.root }));
        print(output, opts); return 0;
      }
      if (operation === 'set') {
        if (!rest[1] || rest[2] === undefined) throw new Error('config set requires a key and value');
        const output = publicConfig(saveConfig({ [rest[1]]: rest[2] }, { rootDir: opts.root }));
        print(output, opts); return 0;
      }
      if (operation === 'get') {
        const config = publicConfig(loadConfig({ rootDir: opts.root }));
        if (rest[1]) {
          const key = canonicalKey(rest[1]);
          print({ [key]: config[key] }, opts);
        } else print(config, opts);
        return 0;
      }
      if (rest.length === 1) {
        const key = canonicalKey(operation);
        const config = publicConfig(loadConfig({ rootDir: opts.root }));
        print({ [key]: config[key] }, opts); return 0;
      }
      if (rest.length === 2) {
        const output = publicConfig(saveConfig({ [operation]: rest[1] }, { rootDir: opts.root }));
        print(output, opts); return 0;
      }
      throw new Error('config expects get, set, reset, a key, or a key and value');
    }
    case 'list-prices': {
      const output = await withClient(opts, (client) => client.listFeeds({
        query: opts.query ?? rest[0] ?? '',
        assetType: opts['asset-type'] || 'crypto',
        limit: opts.limit === undefined ? 50 : integerOption(opts.limit, '--limit', 1, 1000),
        forceRefresh: opts['force-refresh'] === true || opts.refresh === true,
      }));
      print(output, opts, (value) => value.feeds.map((feed) => `${feed.symbol || '(unnamed)'}  ${feed.id}`).join('\n'));
      return 0;
    }
    case 'get-price': {
      const references = rest.flatMap((item) => item.split(',')).map((item) => item.trim()).filter(Boolean);
      if (!references.length) throw new Error('get-price requires at least one feed');
      const options = {
        forceRefresh: opts['force-refresh'] === true || opts.refresh === true,
        cacheTtlMs: opts['cache-ttl'] === undefined ? undefined : integerOption(opts['cache-ttl'], '--cache-ttl', 0, 86400) * 1000,
      };
      const output = await withClient(opts, async (client) => {
        if (references.length === 1) return client.getPrice(references[0], options);
        return client.getPrices(references, options);
      });
      print(output, opts, (value) => value.prices ? value.prices.map(priceLine).join('\n') : priceLine(value));
      return 0;
    }
    case 'watch': {
      if (!rest[0]) throw new Error('watch requires a feed');
      const interval = opts.interval === undefined ? 5000 : integerOption(opts.interval, '--interval', 250, 3600000);
      const count = opts.count === undefined ? 0 : integerOption(opts.count, '--count', 0, 1000000);
      let interrupted = false;
      const stop = () => { interrupted = true; };
      process.once('SIGINT', stop);
      try {
        let emitted = 0;
        while (!interrupted && (count === 0 || emitted < count)) {
          const quote = await withClient(opts, (client) => client.getPrice(rest[0], { forceRefresh: true }));
          if (opts.json) process.stdout.write(`${JSON.stringify(quote)}\n`);
          else process.stdout.write(`${priceLine(quote)}\n`);
          emitted += 1;
          if (!interrupted && (count === 0 || emitted < count)) await new Promise((resolve) => setTimeout(resolve, interval));
        }
      } finally { process.removeListener('SIGINT', stop); }
      return 0;
    }
    case 'mcp-start':
      startMcpServer({ clientOptions: { rootDir: opts.root } });
      return null;
    default: throw new Error(`unknown command "${command}"`);
  }
}

function fail(error) {
  process.stderr.write(`error: ${error.message || String(error)}\n${error.domain ? '' : `\n${USAGE}`}`);
  process.exitCode = error.domain ? 1 : 2;
}

if (require.main === module) {
  run(process.argv.slice(2)).then((code) => {
    if (code !== null && code !== undefined) process.exitCode = code;
  }).catch(fail);
}

module.exports = { run, parse, USAGE, priceLine };
