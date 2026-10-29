'use strict';

const http = require('node:http');
const https = require('node:https');
const { MAX_RESPONSE_BYTES, MAX_REDIRECTS } = require('./constants');

function singleRequest(target, options) {
  return new Promise((resolve, reject) => {
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
          redirected: false,
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

async function nodeFetch(url, options = {}) {
  let target = url instanceof URL ? url : new URL(url);
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const response = await singleRequest(target, options);
    const status = response.status;
    if (status !== 301 && status !== 302 && status !== 303 && status !== 307 && status !== 308) return response;
    const location = response.headers.get('location');
    if (!location) return response;
    if (redirect === MAX_REDIRECTS) {
      const error = new Error(`Too many redirects (limit ${MAX_REDIRECTS})`);
      error.code = 'REDIRECT_UNSUPPORTED';
      throw error;
    }
    try { target = new URL(location, target); }
    catch (cause) {
      const error = new Error(`Invalid redirect location: ${cause.message}`);
      error.code = 'REDIRECT_UNSUPPORTED';
      throw error;
    }
    if (status === 303) options = { ...options, method: 'GET' };
    response.redirected = true;
    response.finalUrl = target.toString();
  }
}

module.exports = { nodeFetch };
