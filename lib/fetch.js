'use strict';

const http = require('node:http');
const https = require('node:https');
const { MAX_RESPONSE_BYTES } = require('./constants');

function nodeFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const target = url instanceof URL ? url : new URL(url);
    const transport = target.protocol === 'https:' ? https : http;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const request = transport.request(target, {
      method: options.method || 'GET',
      headers: options.headers,
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          const error = new Error('Response exceeds the maximum allowed size');
          error.code = 'RESPONSE_TOO_LARGE';
          response.destroy(error);
          fail(error);
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        if (settled) return;
        settled = true;
        const status = response.statusCode || 0;
        resolve({
          status,
          statusText: response.statusMessage || '',
          ok: status >= 200 && status < 300,
          headers: { get: (name) => response.headers[String(name).toLowerCase()] ?? null },
          text: async () => Buffer.concat(chunks).toString('utf8'),
        });
      });
      response.on('error', fail);
    });
    request.on('error', fail);
    if (options.signal) {
      if (options.signal.aborted) {
        const error = new Error('The operation was aborted');
        error.name = 'AbortError';
        request.destroy(error);
        fail(error);
        return;
      }
      options.signal.addEventListener('abort', () => {
        const error = new Error('The operation was aborted');
        error.name = 'AbortError';
        request.destroy(error);
        fail(error);
      }, { once: true });
    }
    request.end();
  });
}

module.exports = { nodeFetch };
