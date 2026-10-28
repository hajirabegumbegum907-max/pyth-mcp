'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteJson } = require('./config');
const { PythError } = require('./errors');

const DEFAULT_MAX_ENTRIES = 1000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

class TTLCache {
  constructor(options = {}) {
    this.filePath = options.filePath ? path.resolve(options.filePath) : null;
    this.now = options.now || (() => Date.now());
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.flushDelayMs = options.flushDelayMs ?? 25;
    this.defaultTtlMs = options.defaultTtlMs ?? 0;
    this.entries = new Map();
    this.loaded = false;
    this.dirty = false;
    this.timer = null;
  }

  load() {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.filePath || !fs.existsSync(this.filePath)) return;
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')); }
    catch (error) { throw new PythError(`Cannot parse cache ${this.filePath}: ${error.message}`, { code: 'CACHE_CORRUPT' }); }
    if (!parsed || ![1, 2].includes(parsed.version) || !parsed.entries || typeof parsed.entries !== 'object' || Array.isArray(parsed.entries)) {
      throw new PythError(`Invalid cache format in ${this.filePath}`, { code: 'CACHE_CORRUPT' });
    }
    for (const [key, entry] of Object.entries(parsed.entries)) {
      if (!entry || !Number.isFinite(entry.storedAt) || !('value' in entry)) continue;
      this.entries.set(key, {
        storedAt: entry.storedAt,
        expiresAt: Number.isFinite(entry.expiresAt) ? entry.expiresAt : null,
        value: entry.value,
      });
    }
    this.prune();
  }

  get(key, ttlMs) {
    this.load();
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    const expired = (entry.expiresAt !== null && entry.expiresAt <= this.now())
      || ttlMs <= 0 || this.now() - entry.storedAt >= ttlMs;
    if (expired) {
      this.entries.delete(key);
      this.dirty = true;
      this.scheduleFlush();
      return undefined;
    }
    return entry.value;
  }

  peek(key) {
    this.load();
    return this.entries.get(key)?.value;
  }

  set(key, value, ttlMs = 0) {
    this.load();
    this.prune();
    this.entries.delete(key);
    const storedAt = this.now();
    this.entries.set(key, {
      storedAt,
      expiresAt: Number.isFinite(ttlMs) && ttlMs > 0 ? storedAt + ttlMs : null,
      value,
    });
    this.dirty = true;
    this.enforceLimits();
    this.scheduleFlush();
    return value;
  }

  delete(key) {
    this.load();
    const deleted = this.entries.delete(key);
    if (deleted) { this.dirty = true; this.scheduleFlush(); }
    return deleted;
  }

  clear() {
    this.load();
    this.entries.clear();
    this.dirty = true;
    this.scheduleFlush();
  }

  prune(ttlMs) {
    this.load();
    const now = this.now();
    let removed = 0;
    for (const [key, entry] of this.entries) {
      const expired = (entry.expiresAt !== null && entry.expiresAt <= now)
        || (Number.isFinite(ttlMs) && now - entry.storedAt >= ttlMs)
        || (entry.expiresAt === null && this.defaultTtlMs > 0 && now - entry.storedAt >= this.defaultTtlMs);
      if (expired) { this.entries.delete(key); removed += 1; }
    }
    if (removed) { this.dirty = true; this.scheduleFlush(); }
    return removed;
  }

  serialized() {
    return `${JSON.stringify({ version: 2, entries: Object.fromEntries(this.entries) }, null, 2)}\n`;
  }

  enforceLimits() {
    while (this.entries.size && this.entries.size > this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value);
      this.dirty = true;
    }
    if (this.maxBytes <= 0) return;
    while (this.entries.size && Buffer.byteLength(this.serialized()) > this.maxBytes) {
      this.entries.delete(this.entries.keys().next().value);
      this.dirty = true;
    }
  }

  scheduleFlush() {
    if (!this.filePath || !this.dirty || this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, this.flushDelayMs);
    this.timer.unref?.();
  }

  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.filePath || !this.dirty) return;
    this.enforceLimits();
    atomicWriteJson(this.filePath, { version: 2, entries: Object.fromEntries(this.entries) });
    this.dirty = false;
  }

  close() { this.flush(); }

  get size() { this.load(); return this.entries.size; }
}

module.exports = { TTLCache, DEFAULT_MAX_ENTRIES, DEFAULT_MAX_BYTES };
