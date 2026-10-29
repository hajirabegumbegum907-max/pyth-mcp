'use strict';

const http = require('node:http');
const https = require('node:https');
const { MAX_RESPONSE_BYTES, MAX_FEEDS_PER_REQUEST, PACKAGE_VERSION } = require('./constants');
const { PythError, ValidationError } = require('./errors');
const { normalizeFeedId, isFeedId } = require('./validation');

const MAX_STREAM_DURATION_MS = 300000;
const MAX_STREAM_UPDATES = 1000;

function resolveStreamUrl(baseUrl, feedIds, options = {}) {
  const url = new URL('/v2/updates/price/stream', `${baseUrl}/`);
  for (const id of feedIds) url.searchParams.append('ids[]', id);
  url.searchParams.set('parsed', 'true');
  if (options.allowUnordered) url.searchParams.set('allow_unordered', 'true');
  if (options.threshold !== undefined) url.searchParams.set('threshold', String(options.threshold));
  if (options.encoding) url.searchParams.set('encoding', options.encoding);
  return url;
}

function streamPrices({ baseUrl, apiKey, feedIds, onUpdate, onError, durationMs, maxUpdates, allowUnordered, threshold, encoding, signal }) {
  if (!Array.isArray(feedIds) || feedIds.length < 1 || feedIds.length > MAX_FEEDS_PER_REQUEST) {
    throw new ValidationError(`feedIds must contain between 1 and ${MAX_FEEDS_PER_REQUEST} ids`);
  }
  for (const id of feedIds) {
    if (!isFeedId(id)) throw new ValidationError('Each feed id must be 64 hexadecimal characters');
  }
  const duration = Math.min(Math.max(durationMs ?? 30000, 1000), MAX_STREAM_DURATION_MS);
  const cap = Math.min(Math.max(maxUpdates ?? 100, 1), MAX_STREAM_UPDATES);
  const url = resolveStreamUrl(baseUrl, feedIds.map(normalizeFeedId), { allowUnordered, threshold, encoding });

  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const updates = [];
    let settled = false;
    let receivedBytes = 0;
    let buffer = '';
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { request.destroy(); } catch { /* already closed */ }
      if (error) reject(error);
      else resolve({ updates, count: updates.length, truncated: updates.length >= cap, durationMs: duration });
    };
    const timer = setTimeout(() => finish(), duration);
    const request = transport.request(url, {
      method: 'GET',
      headers: {
        accept: 'text/event-stream',
        'user-agent': `pyth-mcp/${PACKAGE_VERSION}`,
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
    }, (response) => {
      const status = response.statusCode || 0;
      if (status === 301 || status === 302 || status === 307 || status === 308) {
        const location = response.headers.location;
        response.resume();
        if (location) {
          try {
            const redirectTarget = new URL(location, url);
            response.destroy();
            settled = true;
            clearTimeout(timer);
            streamPrices({
              baseUrl: redirectTarget.origin, apiKey, feedIds,
              onUpdate, onError, durationMs: duration, maxUpdates: cap,
              allowUnordered, threshold, encoding, signal,
            }).then(resolve, reject);
            return;
          } catch (error) { finish(new PythError(`Invalid redirect location: ${error.message}`, { code: 'REDIRECT_UNSUPPORTED' })); return; }
        }
        finish(new PythError(`Hermes stream redirect with no location (HTTP ${status})`, { code: 'REDIRECT_UNSUPPORTED', status }));
        return;
      }
      if (status !== 200) {
        response.resume();
        finish(new PythError(`Hermes stream HTTP ${status}`, { code: 'HERMES_HTTP_ERROR', status, retryable: status === 429 || status >= 500 }));
        return;
      }
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        if (settled) return;
        receivedBytes += Buffer.byteLength(chunk);
        if (receivedBytes > MAX_RESPONSE_BYTES) {
          finish(new PythError('Hermes stream exceeded the 8 MiB limit', { code: 'RESPONSE_TOO_LARGE' }));
          return;
        }
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const parsed = JSON.parse(payload);
            const events = Array.isArray(parsed) ? parsed : [parsed];
            for (const event of events) {
              updates.push(event);
              if (onUpdate) { try { onUpdate(event); } catch { /* listener errors must not kill the stream */ } }
            }
          } catch (error) {
            if (onError) { try { onError(error); } catch { /* ignore listener errors */ } }
          }
          if (updates.length >= cap) { finish(); return; }
        }
      });
      response.on('error', (error) => finish(new PythError(`Hermes stream failed: ${error.message}`, { code: 'HERMES_UNREACHABLE', cause: error })));
      response.on('end', () => finish());
    });
    request.on('error', (error) => finish(new PythError(`Hermes stream request failed: ${error.message}`, { code: 'HERMES_UNREACHABLE', cause: error })));
    if (signal) {
      if (signal.aborted) { request.destroy(); finish(); return; }
      signal.addEventListener('abort', () => finish(), { once: true });
    }
    request.end();
  });
}

module.exports = { streamPrices, resolveStreamUrl, MAX_STREAM_DURATION_MS, MAX_STREAM_UPDATES };
