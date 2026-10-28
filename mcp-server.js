#!/usr/bin/env node
'use strict';

const { PythClient } = require('./lib/client');
const { createMcpHandler } = require('./lib/mcp-handlers');
const {
  PACKAGE_NAME,
  PACKAGE_VERSION,
  PROTOCOL_VERSION,
  MAX_STDIN_BUFFER,
} = require('./lib/constants');

function startMcpServer(options = {}) {
  const client = options.client || new PythClient(options.clientOptions);
  const stdin = options.stdin || process.stdin;
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  const handler = createMcpHandler({
    client,
    serverInfo: options.serverInfo || { name: PACKAGE_NAME, version: PACKAGE_VERSION },
  });
  let buffer = '';
  let discardOversizedLine = false;
  let closing = false;
  let queue = Promise.resolve();

  const write = (message) => {
    if (!closing && message !== undefined) stdout.write(`${JSON.stringify(message)}\n`);
  };
  const failure = (code, message) => ({ jsonrpc: '2.0', id: null, error: { code, message } });

  async function handle(message) {
    if (Array.isArray(message)) {
      if (handler.protocolVersion === null || handler.protocolVersion === PROTOCOL_VERSION) {
        write(failure(-32600, 'JSON-RPC batching is not supported by protocol version 2025-06-18'));
        return;
      }
      if (message.length === 0) { write(failure(-32600, 'Invalid Request: empty batch')); return; }
      const responses = [];
      for (const item of message) {
        const response = await handler.handleMessage(item);
        if (response !== undefined) responses.push(response);
      }
      if (responses.length) write(responses);
      return;
    }
    write(await handler.handleMessage(message));
  }

  function receive(line) {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); }
    catch { write(failure(-32700, 'Parse error: line is not valid JSON')); return; }
    queue = queue.then(() => handle(message)).catch((error) => {
      write({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error', data: error.message } });
    });
  }

  function onData(chunk) {
    if (discardOversizedLine) {
      const newline = chunk.indexOf('\n');
      if (newline < 0) return;
      chunk = chunk.slice(newline + 1);
      discardOversizedLine = false;
    }
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.length > MAX_STDIN_BUFFER) {
        write(failure(-32600, 'Invalid Request: maximum stdin line size exceeded'));
        continue;
      }
      receive(line);
    }
    if (buffer.length > MAX_STDIN_BUFFER) {
      buffer = '';
      discardOversizedLine = true;
      write(failure(-32600, 'Invalid Request: maximum stdin line size exceeded'));
    }
  }

  function close() {
    if (closing) return;
    closing = true;
    try { stdin.pause?.(); } catch { /* stream already closed */ }
    client.close();
  }

  stdin.setEncoding('utf8');
  stdin.on('data', onData);
  stdin.on('end', () => {
    if (!discardOversizedLine && buffer.trim()) receive(buffer);
    queue.finally(close);
  });
  if (!options.disableSignalHandlers) {
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
  }
  stderr.write(`[pyth-mcp] MCP server ready (protocol ${PROTOCOL_VERSION})\n`);
  stderr.write(`[pyth-mcp] state directory: ${client.config.stateDir}\n`);
  return { client, handler, close, queue: () => queue };
}

if (require.main === module) {
  try { startMcpServer(); }
  catch (error) {
    process.stderr.write(`[pyth-mcp] fatal: ${error.message || String(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = { startMcpServer };
