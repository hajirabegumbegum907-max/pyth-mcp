'use strict';

const {
  MAJOR_FEEDS,
  MAX_FEEDS_PER_REQUEST,
  MAX_RESPONSE_BYTES,
  DEFAULT_RETRY_BACKOFF_MS,
  DEFAULT_STALE_AFTER_MS,
  DEFAULT_PRICE_HISTORY_LIMIT,
  PACKAGE_VERSION,
} = require('./constants');
const { loadConfig } = require('./config');
const { TTLCache } = require('./cache');
const { nodeFetch } = require('./fetch');
const { PythError, ValidationError } = require('./errors');
const { isFeedId, normalizeFeedId, normalizeSymbol } = require('./validation');

const MAJOR_BY_ID = new Map(MAJOR_FEEDS.map((feed) => [feed.id, feed]));
const MAJOR_BY_SYMBOL = new Map(MAJOR_FEEDS.map((feed) => [normalizeSymbol(feed.symbol), feed]));

function cloneFeed(feed) {
  return {
    id: feed.id,
    symbol: feed.symbol || null,
    base: feed.base || null,
    quoteCurrency: feed.quoteCurrency || null,
    assetType: feed.assetType || null,
    name: feed.name || null,
  };
}

function normalizeFeed(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new PythError('Hermes returned an invalid feed entry', { code: 'INVALID_RESPONSE' });
  const id = normalizeFeedId(raw.id || '');
  const attributes = raw.attributes && typeof raw.attributes === 'object' ? raw.attributes : raw;
  const symbol = typeof attributes.symbol === 'string' ? attributes.symbol : null;
  const base = attributes.base || (symbol ? symbol.replace(/^Crypto\./i, '').split('/')[0] : null);
  const quoteCurrency = attributes.quote_currency || attributes.quoteCurrency || (symbol && symbol.includes('/') ? symbol.split('/')[1] : null);
  return {
    id,
    symbol,
    base: base || null,
    quoteCurrency: quoteCurrency || null,
    assetType: attributes.asset_type || attributes.assetType || null,
    name: attributes.description || attributes.name || null,
  };
}

function decimalValue(raw, exponent, label) {
  if (raw === undefined || raw === null || raw === '') return { text: null, number: null, raw: null };
  if (!Number.isInteger(exponent) || exponent < -100 || exponent > 100) {
    throw new PythError(`${label} exponent must be an integer between -100 and 100`, { code: 'INVALID_RESPONSE' });
  }
  const textRaw = String(raw);
  if (!/^-?\d+$/.test(textRaw)) throw new PythError(`${label} must be an integer string`, { code: 'INVALID_RESPONSE' });
  const negative = textRaw.startsWith('-');
  let digits = textRaw.replace(/^-/, '').replace(/^0+(?=\d)/, '');
  let text;
  if (exponent < 0) {
    const scale = -exponent;
    if (digits.length <= scale) digits = digits.padStart(scale + 1, '0');
    const split = digits.length - scale;
    text = `${digits.slice(0, split)}.${digits.slice(split)}`;
  } else {
    text = `${digits}${'0'.repeat(exponent)}`;
  }
  let [integer, fraction = ''] = text.split('.');
  integer = integer.replace(/^0+(?=\d)/, '');
  fraction = fraction.replace(/0+$/, '');
  text = `${negative ? '-' : ''}${integer}${fraction ? `.${fraction}` : ''}`;
  const numeric = Number(text);
  return { text, number: Number.isFinite(numeric) ? numeric : null, raw: textRaw };
}

function isoFromUnix(value) {
  if (!Number.isInteger(value) || value < 0) return null;
  const date = new Date(value * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function parseRetryAfter(headerValue) {
  if (headerValue === undefined || headerValue === null || headerValue === '') return null;
  const raw = String(headerValue).trim();
  if (/^\d+$/.test(raw)) {
    const seconds = Number(raw);
    return Number.isFinite(seconds) ? seconds * 1000 : null;
  }
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
}

function normalizePriceUpdate(raw, feed, cached, fetchedAt, nowMs) {
  if (!raw || typeof raw !== 'object' || !raw.price) throw new PythError('Hermes returned an invalid price update', { code: 'INVALID_RESPONSE' });
  const id = normalizeFeedId(raw.id || feed.id);
  const exponent = raw.price.expo;
  const price = decimalValue(raw.price.price, exponent, 'price');
  const confidence = decimalValue(raw.price.conf, exponent, 'confidence');
  const emaExponent = raw.ema_price && raw.ema_price.expo !== undefined ? raw.ema_price.expo : exponent;
  const emaPrice = decimalValue(raw.ema_price?.price, emaExponent, 'ema price');
  const emaConfidence = decimalValue(raw.ema_price?.conf, emaExponent, 'ema confidence');
  const publishTime = raw.price.publish_time;
  if (!Number.isInteger(publishTime)) throw new PythError('Price update is missing an integer publish_time', { code: 'INVALID_RESPONSE' });
  const referenceMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const stalenessMs = Math.max(0, referenceMs - publishTime * 1000);
  return {
    id,
    symbol: feed.symbol || null,
    name: feed.name || null,
    assetType: feed.assetType || null,
    price: price.number,
    priceText: price.text,
    confidence: confidence.number,
    confidenceText: confidence.text,
    exponent,
    publishTime,
    publishTimeIso: isoFromUnix(publishTime),
    stalenessSeconds: Math.round(stalenessMs / 1000),
    stale: stalenessMs > DEFAULT_STALE_AFTER_MS,
    emaPrice: emaPrice.number,
    emaPriceText: emaPrice.text,
    emaConfidence: emaConfidence.number,
    emaConfidenceText: emaConfidence.text,
    raw: {
      price: price.raw,
      confidence: confidence.raw,
      emaPrice: emaPrice.raw,
      emaConfidence: emaConfidence.raw,
      emaExponent,
    },
    metadata: raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : {},
    cached,
    fetchedAt,
  };
}

class PythClient {
  constructor(options = {}) {
    this.config = loadConfig({ rootDir: options.rootDir, env: options.env, overrides: options.overrides });
    this.fetchImpl = options.fetch || nodeFetch;
    if (typeof this.fetchImpl !== 'function') throw new PythError('A Fetch API implementation is required', { code: 'FETCH_UNAVAILABLE' });
    this.sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.retryBackoffMs = options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
    this.cache = options.cache || new TTLCache({
      filePath: this.config.cachePath,
      now: options.now,
      defaultTtlMs: Math.max(this.config.cacheTtlMs, this.config.catalogTtlMs),
    });
    this.historyLimit = options.historyLimit ?? DEFAULT_PRICE_HISTORY_LIMIT;
    this.history = new Map();
  }

  recordHistory(feedId, quote) {
    if (!this.historyLimit) return;
    let entries = this.history.get(feedId);
    if (!entries) { entries = []; this.history.set(feedId, entries); }
    entries.push(quote);
    if (entries.length > this.historyLimit) entries.splice(0, entries.length - this.historyLimit);
  }

  async getPriceHistory(reference, options = {}) {
    const feed = await this.resolveFeed(reference);
    const limit = options.limit === undefined ? this.historyLimit : options.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 5000) throw new ValidationError('limit must be an integer between 1 and 5000');
    const entries = this.history.get(feed.id) || [];
    return {
      id: feed.id,
      symbol: feed.symbol || null,
      count: entries.length,
      returned: Math.min(limit, entries.length),
      prices: entries.slice(-limit),
    };
  }

  async request(pathname, searchParams = {}) {
    const url = new URL(pathname, `${this.config.baseUrl}/`);
    for (const [key, value] of Object.entries(searchParams)) {
      if (Array.isArray(value)) value.forEach((item) => url.searchParams.append(key, String(item)));
      else if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    let lastError;
    for (let attempt = 0; attempt <= this.config.retries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
      try {
        const response = await this.fetchImpl(url, {
          method: 'GET',
          headers: {
            accept: 'application/json',
            'user-agent': `pyth-mcp/${PACKAGE_VERSION}`,
            ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
          },
          signal: controller.signal,
        });
        const declaredLength = Number(response.headers?.get?.('content-length') || 0);
        if (declaredLength > MAX_RESPONSE_BYTES) {
          throw new PythError('Hermes response exceeds the 8 MiB limit', { code: 'RESPONSE_TOO_LARGE', status: response.status });
        }
        const text = await response.text();
        if (text.length > MAX_RESPONSE_BYTES) {
          throw new PythError('Hermes response exceeds the 8 MiB limit', { code: 'RESPONSE_TOO_LARGE', status: response.status });
        }
        if (!response.ok) {
          const retryable = response.status === 429 || response.status >= 500;
          const authenticationHint = response.status === 401
            ? (this.config.apiKey ? '; verify the configured Pyth API key' : '; set PYTH_API_KEY or configure apiKey for Hermes price updates')
            : '';
          const retryAfterMs = parseRetryAfter(response.headers?.get?.('retry-after'));
          throw new PythError(`Hermes HTTP ${response.status}: ${text.slice(0, 500) || response.statusText}${authenticationHint}`, {
            code: 'HERMES_HTTP_ERROR', status: response.status, retryable, retryAfterMs,
          });
        }
        try { return JSON.parse(text); }
        catch (error) { throw new PythError(`Hermes returned invalid JSON: ${error.message}`, { code: 'INVALID_RESPONSE', status: response.status }); }
      } catch (error) {
        const timedOut = error && error.name === 'AbortError';
        const wrapped = error instanceof PythError ? error : new PythError(
          timedOut ? `Hermes request timed out after ${this.config.timeoutMs} ms` : `Hermes request failed: ${error.message || String(error)}`,
          { code: timedOut ? 'HERMES_TIMEOUT' : 'HERMES_UNREACHABLE', retryable: true, cause: error },
        );
        lastError = wrapped;
        if (attempt >= this.config.retries || !wrapped.retryable) throw wrapped;
        const backoffMs = this.retryBackoffMs * (2 ** attempt);
        const waitMs = Math.min(Math.max(wrapped.retryAfterMs ?? backoffMs, backoffMs), 60000);
        await this.sleep(waitMs);
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError;
  }

  async listFeeds(options = {}) {
    const query = options.query === undefined ? '' : String(options.query).trim();
    if (query.length > 128) throw new ValidationError('Feed query must contain at most 128 characters');
    const requestedAssetType = options.assetType ?? options.asset_type ?? 'crypto';
    const assetType = requestedAssetType === '*' ? '' : requestedAssetType;
    if (assetType && !/^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/.test(assetType)) throw new ValidationError('assetType has an invalid format');
    const limit = options.limit === undefined ? 50 : options.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new ValidationError('limit must be an integer between 1 and 1000');
    const forceRefresh = options.forceRefresh ?? options.force_refresh ?? false;
    if (typeof forceRefresh !== 'boolean') throw new ValidationError('forceRefresh must be boolean');
    const cacheKey = `catalog:${assetType.toLowerCase()}:${query.toLowerCase()}`;
    let payload = forceRefresh ? undefined : this.cache.get(cacheKey, this.config.catalogTtlMs);
    let cached = Boolean(payload);
    if (payload && payload.fetchedLimit !== undefined && limit > payload.fetchedLimit) {
      payload = undefined;
      cached = false;
    }
    if (!payload) {
      const fetchedLimit = limit;
      const body = await this.request('/v2/price_feeds', { query, asset_type: assetType || undefined, limit });
      if (!Array.isArray(body)) throw new PythError('Hermes price_feeds response must be an array', { code: 'INVALID_RESPONSE' });
      const seen = new Set();
      const feeds = [];
      const skipped = [];
      for (const raw of body) {
        try {
          const feed = normalizeFeed(raw);
          if (seen.has(feed.id)) continue;
          seen.add(feed.id);
          feeds.push(feed);
        } catch (error) {
          skipped.push(error.message || String(error));
        }
      }
      feeds.sort((a, b) => (a.symbol || a.id).localeCompare(b.symbol || b.id));
      payload = { feeds, fetchedAt: new Date().toISOString(), fetchedLimit, skipped };
      if (this.config.catalogTtlMs > 0) this.cache.set(cacheKey, payload, this.config.catalogTtlMs);
    }
    return {
      feeds: payload.feeds.slice(0, limit),
      count: payload.feeds.length,
      returned: Math.min(limit, payload.feeds.length),
      query,
      assetType: assetType || 'all',
      cached,
      fetchedAt: payload.fetchedAt,
    };
  }

  async resolveFeed(reference) {
    if (typeof reference !== 'string' || !reference.trim()) throw new ValidationError('feed must be a non-empty string');
    const input = reference.trim();
    if (isFeedId(input)) {
      const id = normalizeFeedId(input);
      return cloneFeed(MAJOR_BY_ID.get(id) || { id });
    }
    const symbol = normalizeSymbol(input);
    const builtIn = MAJOR_BY_SYMBOL.get(symbol);
    if (builtIn) return cloneFeed(builtIn);
    const result = await this.listFeeds({ query: input, assetType: '*', limit: 100 });
    const exact = result.feeds.filter((feed) => normalizeSymbol(feed.symbol) === symbol);
    let candidates = exact;
    if (!candidates.length) candidates = result.feeds.filter((feed) => normalizeSymbol(feed.base) === symbol && normalizeSymbol(feed.quoteCurrency) === 'USD');
    if (!candidates.length && result.feeds.length === 1) candidates = result.feeds;
    if (!candidates.length) throw new PythError(`No Pyth price feed matches "${input}"`, { code: 'FEED_NOT_FOUND' });
    const ids = new Set(candidates.map((feed) => feed.id));
    if (ids.size !== 1) {
      throw new PythError(`Feed reference "${input}" is ambiguous; use a full symbol or 64-character feed id`, {
        code: 'AMBIGUOUS_FEED',
        details: { candidates: candidates.slice(0, 10).map((feed) => ({ id: feed.id, symbol: feed.symbol })) },
      });
    }
    return candidates[0];
  }

  async getPrice(reference, options = {}) {
    const result = await this.getPrices([reference], options);
    return result.prices[0];
  }

  async getPrices(references, options = {}) {
    if (!Array.isArray(references) || references.length < 1 || references.length > MAX_FEEDS_PER_REQUEST) {
      throw new ValidationError(`feeds must contain between 1 and ${MAX_FEEDS_PER_REQUEST} references`);
    }
    const forceRefresh = options.forceRefresh ?? options.force_refresh ?? false;
    if (typeof forceRefresh !== 'boolean') throw new ValidationError('forceRefresh must be boolean');
    const allowStale = options.allowStale ?? options.allow_stale ?? false;
    if (typeof allowStale !== 'boolean') throw new ValidationError('allowStale must be boolean');
    const cacheTtlMs = options.cacheTtlMs ?? options.cache_ttl_ms ?? this.config.cacheTtlMs;
    if (!Number.isInteger(cacheTtlMs) || cacheTtlMs < 0 || cacheTtlMs > 86400000) {
      throw new ValidationError('cacheTtlMs must be an integer between 0 and 86400000');
    }
    const feeds = [];
    const errors = [];
    const failures = [];
    const recordError = (reference, feed, error) => {
      failures.push(error);
      errors.push({
        reference,
        id: feed?.id || null,
        code: error.code || 'PYTH_ERROR',
        message: error.message || String(error),
        ...(error.details === undefined ? {} : { details: error.details }),
      });
    };
    const seenReferences = new Set();
    for (const reference of references) {
      let feed;
      try { feed = await this.resolveFeed(reference); }
      catch (error) { recordError(reference, null, error); continue; }
      if (seenReferences.has(feed.id)) continue;
      seenReferences.add(feed.id);
      feeds.push(feed);
    }
    const quotes = new Map();
    const missing = [];
    for (const feed of feeds) {
      const cached = forceRefresh ? undefined : this.cache.get(`price:${feed.id}`, cacheTtlMs);
      if (cached) quotes.set(feed.id, { ...cached, symbol: cached.symbol || feed.symbol, name: cached.name || feed.name, cached: true });
      else missing.push(feed);
    }
    if (missing.length) {
      let body;
      try {
        body = await this.request('/v2/updates/price/latest', {
          'ids[]': missing.map((feed) => feed.id),
          parsed: true,
        });
        if (!body || !Array.isArray(body.parsed)) throw new PythError('Hermes latest price response is missing the parsed array', { code: 'INVALID_RESPONSE' });
      } catch (error) {
        for (const feed of missing) recordError(feed.symbol || feed.id, feed, error);
        body = null;
        if (allowStale) {
          for (const feed of missing) {
            const history = this.history.get(feed.id);
            const last = history && history.length ? history[history.length - 1] : null;
            if (last) quotes.set(feed.id, { ...last, cached: true, stale: true, staleSource: 'history' });
          }
        }
      }
      if (body) {
        const updates = new Map();
        for (const raw of body.parsed) {
          try { if (raw && raw.id) updates.set(normalizeFeedId(raw.id), raw); }
          catch { /* Invalid entries are handled as missing updates below. */ }
        }
        const fetchedAt = new Date().toISOString();
        for (const feed of missing) {
          const raw = updates.get(feed.id);
          if (!raw) {
            recordError(feed.symbol || feed.id, feed, new PythError(`Hermes returned no latest price for ${feed.symbol || feed.id}`, {
              code: 'PRICE_NOT_FOUND', details: { id: feed.id },
            }));
            continue;
          }
          try {
            const quote = normalizePriceUpdate(raw, feed, false, fetchedAt);
            quotes.set(feed.id, quote);
            this.recordHistory(feed.id, quote);
            if (cacheTtlMs > 0) this.cache.set(`price:${feed.id}`, quote, cacheTtlMs);
          } catch (error) { recordError(feed.symbol || feed.id, feed, error); }
        }
      }
    }
    const prices = feeds.filter((feed) => quotes.has(feed.id)).map((feed) => quotes.get(feed.id));
    if (!prices.length && failures.length) throw failures[0];
    return {
      prices,
      count: prices.length,
      cached: prices.length > 0 && prices.every((quote) => quote.cached),
      fetchedAt: prices.find((quote) => !quote.cached)?.fetchedAt || prices[0]?.fetchedAt || null,
      errors,
      errorCount: errors.length,
    };
  }

  majorFeeds() { return MAJOR_FEEDS.map(cloneFeed); }

  async streamPrices(references, options = {}) {
    const { streamPrices } = require('./stream');
    const list = Array.isArray(references) ? references : [references];
    const feedIds = [];
    const seen = new Set();
    for (const reference of list) {
      const feed = await this.resolveFeed(reference);
      if (seen.has(feed.id)) continue;
      seen.add(feed.id);
      feedIds.push(feed.id);
    }
    return streamPrices({
      baseUrl: this.config.baseUrl,
      apiKey: this.config.apiKey,
      feedIds,
      onUpdate: options.onUpdate,
      onError: options.onError,
      durationMs: options.durationMs,
      maxUpdates: options.maxUpdates,
      allowUnordered: options.allowUnordered,
      threshold: options.threshold,
      encoding: options.encoding,
      signal: options.signal,
    });
  }

  async ping() {
    const result = await this.listFeeds({ query: 'BTC/USD', limit: 1, forceRefresh: true });
    return { status: 'ok', service: 'pyth-hermes', baseUrl: this.config.baseUrl, feedCount: result.count, checkedAt: new Date().toISOString() };
  }

  close() { this.cache.close(); }
}

module.exports = {
  PythClient,
  normalizeFeed,
  normalizePriceUpdate,
  decimalValue,
  isoFromUnix,
  cloneFeed,
  parseRetryAfter,
};
