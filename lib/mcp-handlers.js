'use strict';

const { TOOLS, callTool } = require('./mcp-tools');
const { validateSchema, isObject } = require('./validation');
const { publicError, PythError } = require('./errors');
const { PROTOCOL_VERSION, SUPPORTED_VERSIONS } = require('./constants');

const INITIALIZE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['protocolVersion', 'capabilities', 'clientInfo'],
  properties: {
    protocolVersion: { type: 'string', minLength: 1 },
    capabilities: { type: 'object' },
    clientInfo: {
      type: 'object', additionalProperties: false, required: ['name', 'version'],
      properties: {
        name: { type: 'string', minLength: 1 },
        version: { type: 'string', minLength: 1 },
      },
    },
  },
};

const TOOL_CALL_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['name'],
  properties: { name: { type: 'string', minLength: 1 }, arguments: { type: 'object' } },
};

function textResult(value, isError = false) {
  return {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

function createMcpHandler({ client, serverInfo }) {
  let initialized = false;
  let protocolVersion = null;
  const byName = new Map(TOOLS.map((tool) => [tool.name, tool]));
  const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message, data) => ({
    jsonrpc: '2.0', id: id === undefined ? null : id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  });

  async function handleMessage(message) {
    if (!isObject(message)) return fail(null, -32600, 'Invalid Request: expected a JSON-RPC object');
    const hasId = Object.prototype.hasOwnProperty.call(message, 'id');
    const id = hasId ? message.id : null;
    if (message.jsonrpc !== '2.0' || typeof message.method !== 'string' || !message.method) {
      return fail(id, -32600, 'Invalid Request: jsonrpc and a non-empty method are required');
    }
    if (hasId && id !== null && typeof id !== 'string' && typeof id !== 'number') {
      return fail(null, -32600, 'Invalid Request: id must be a string, number, or null');
    }
    const notification = !hasId;
    if (!initialized && message.method !== 'initialize') {
      return notification ? undefined : fail(id, -32002, 'Server not initialized: send initialize first');
    }

    try {
      switch (message.method) {
        case 'initialize': {
          if (notification) return undefined;
          if (initialized) return fail(id, -32600, 'Invalid Request: server is already initialized');
          validateSchema(message.params, INITIALIZE_SCHEMA, 'params');
          protocolVersion = SUPPORTED_VERSIONS.includes(message.params.protocolVersion)
            ? message.params.protocolVersion : PROTOCOL_VERSION;
          initialized = true;
          return ok(id, {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo,
            instructions: 'Use pyth_resolve_feed or pyth_list_feeds to discover feeds, then pyth_get_price or pyth_get_prices for latest oracle prices and confidence intervals.',
          });
        }
        case 'notifications/initialized':
        case 'notifications/cancelled':
          return undefined;
        case 'ping': return notification ? undefined : ok(id, {});
        case 'tools/list': return notification ? undefined : ok(id, { tools: TOOLS });
        case 'tools/call': {
          if (notification) return undefined;
          validateSchema(message.params, TOOL_CALL_SCHEMA, 'params');
          const tool = byName.get(message.params.name);
          if (!tool) return fail(id, -32602, `Unknown tool: ${message.params.name}`);
          const args = message.params.arguments === undefined ? {} : message.params.arguments;
          validateSchema(args, tool.inputSchema, 'params.arguments');
          try {
            const result = await callTool(client, message.params.name, args);
            return ok(id, textResult(result));
          } catch (error) {
            if (error instanceof PythError || error?.domain) return ok(id, textResult({ error: publicError(error) }, true));
            throw error;
          }
        }
        case 'shutdown': return notification ? undefined : ok(id, null);
        default: return notification ? undefined : fail(id, -32601, `Method not found: ${message.method}`);
      }
    } catch (error) {
      if (error instanceof PythError && error.code === 'VALIDATION_ERROR') return fail(id, -32602, 'Invalid params', error.message);
      return fail(id, -32603, 'Internal error', error.message || String(error));
    }
  }

  return {
    tools: TOOLS,
    handleMessage,
    get protocolVersion() { return protocolVersion; },
    get initialized() { return initialized; },
  };
}

module.exports = { createMcpHandler, textResult, INITIALIZE_SCHEMA, TOOL_CALL_SCHEMA };
