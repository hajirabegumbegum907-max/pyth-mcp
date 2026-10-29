export interface Feed {
  id: string;
  symbol: string | null;
  base: string | null;
  quoteCurrency: string | null;
  assetType: string | null;
  name: string | null;
}

export interface PriceUpdate {
  id: string;
  symbol: string | null;
  name: string | null;
  assetType: string | null;
  price: number | null;
  priceText: string | null;
  confidence: number | null;
  confidenceText: string | null;
  exponent: number;
  publishTime: number;
  publishTimeIso: string | null;
  stalenessSeconds: number;
  stale: boolean;
  emaPrice: number | null;
  emaPriceText: string | null;
  emaConfidence: number | null;
  emaConfidenceText: string | null;
  raw: {
    price: string | null;
    confidence: string | null;
    emaPrice: string | null;
    emaConfidence: string | null;
    emaExponent: number;
  };
  metadata: Record<string, unknown>;
  cached: boolean;
  fetchedAt: string;
  staleSource?: 'history';
}

export interface PriceResult {
  prices: PriceUpdate[];
  count: number;
  cached: boolean;
  fetchedAt: string | null;
  errors: Array<{ reference: string; id: string | null; code: string; message: string; details?: unknown }>;
  errorCount: number;
}

export interface ListFeedsResult {
  feeds: Feed[];
  count: number;
  returned: number;
  query: string;
  assetType: string;
  cached: boolean;
  fetchedAt: string;
}

export interface PriceHistoryResult {
  id: string;
  symbol: string | null;
  count: number;
  returned: number;
  prices: PriceUpdate[];
}

export interface StreamResult {
  updates: unknown[];
  count: number;
  truncated: boolean;
  durationMs: number;
}

export interface PythConfig {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  cacheTtlMs: number;
  catalogTtlMs: number;
  retries: number;
  rootDir: string;
  configPath: string;
  cachePath: string;
}

export interface GetPriceOptions {
  forceRefresh?: boolean;
  allowStale?: boolean;
  cacheTtlMs?: number;
}

export interface StreamOptions {
  onUpdate?: (event: unknown) => void;
  onError?: (error: Error) => void;
  durationMs?: number;
  maxUpdates?: number;
  allowUnordered?: boolean;
  threshold?: number;
  encoding?: string;
  signal?: AbortSignal;
}

export declare class PythClient {
  constructor(options?: {
    rootDir?: string;
    env?: Record<string, string | undefined>;
    overrides?: Partial<PythConfig>;
    fetch?: unknown;
    sleep?: (ms: number) => Promise<void>;
    retryBackoffMs?: number;
    historyLimit?: number;
    cache?: unknown;
    now?: () => number;
  });
  config: PythConfig;
  request(pathname: string, searchParams?: Record<string, unknown>): Promise<unknown>;
  listFeeds(options?: { query?: string; assetType?: string; limit?: number; forceRefresh?: boolean }): Promise<ListFeedsResult>;
  resolveFeed(reference: string): Promise<Feed>;
  getPrice(reference: string, options?: GetPriceOptions): Promise<PriceUpdate>;
  getPrices(references: string[], options?: GetPriceOptions): Promise<PriceResult>;
  getPriceHistory(reference: string, options?: { limit?: number }): Promise<PriceHistoryResult>;
  streamPrices(references: string | string[], options?: StreamOptions): Promise<StreamResult>;
  majorFeeds(): Feed[];
  ping(): Promise<{ status: string; service: string; baseUrl: string; feedCount: number; checkedAt: string }>;
  close(): void;
}

export declare class TTLCache {
  constructor(options?: {
    filePath?: string;
    now?: () => number;
    maxEntries?: number;
    maxBytes?: number;
    flushDelayMs?: number;
    defaultTtlMs?: number;
  });
  load(): void;
  get(key: string, ttlMs?: number): unknown;
  peek(key: string): unknown;
  set(key: string, value: unknown, ttlMs?: number): unknown;
  delete(key: string): boolean;
  clear(): void;
  prune(ttlMs?: number): number;
  flush(): void;
  close(): void;
  readonly size: number;
}

export declare class PythError extends Error {
  code: string;
  domain: boolean;
  status: number | null;
  retryable: boolean;
  retryAfterMs: number | null;
  details?: unknown;
}

export declare class ConfigError extends PythError {}
export declare class ValidationError extends PythError {}

export declare const MAJOR_FEEDS: Feed[];
export declare const DEFAULT_CONFIG: Record<string, unknown>;
export declare const PROTOCOL_VERSION: string;
export declare const SUPPORTED_VERSIONS: string[];

export declare function loadConfig(options?: { rootDir?: string; env?: Record<string, string | undefined>; overrides?: Record<string, unknown> }): PythConfig;
export declare function initConfig(options?: { rootDir?: string }): { config: PythConfig; created: string[] };
export declare function saveConfig(patch: Record<string, unknown>, options?: { rootDir?: string }): PythConfig;
export declare function resetConfig(options?: { rootDir?: string }): PythConfig;
export declare function publicConfig(config: PythConfig): Record<string, unknown>;
export declare function normalizeFeed(raw: unknown): Feed;
export declare function normalizePriceUpdate(raw: unknown, feed: Feed, cached: boolean, fetchedAt: string, nowMs?: number): PriceUpdate;
export declare function decimalValue(raw: unknown, exponent: number, label: string): { text: string | null; number: number | null; raw: string | null };
export declare function startMcpServer(options?: Record<string, unknown>): { client: PythClient; handler: unknown; close(): void; queue(): Promise<void> };
