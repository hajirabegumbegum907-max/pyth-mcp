# pyth-mcp

Pyth Network Hermes price feeds with a feed catalog, exact exponent handling,
confidence intervals, EMA prices, TTL caching, a CLI, and an MCP stdio server.
The implementation uses only Node.js built-ins and has no install scripts.

## Properties

- Node.js 20 or newer; zero runtime dependencies
- Latest Pyth prices with raw integer values, exact decimal text, exponent,
  confidence interval, EMA price, publish time, and metadata
- Feed resolution by symbol, base asset, or 64-character hexadecimal feed id
- Built-in mappings for BTC/USD, ETH/USD, SOL/USD, USDC/USD, and USDT/USD
- Hermes catalog search for all other supported Pyth feeds and asset types
- Per-feed price cache and query-specific catalog cache persisted on disk
- Expiration pruning, 1,000-entry and 8 MiB cache limits, and batched writes
- Bounded timeouts, retries, response sizes, and MCP stdin messages
- Five MCP tools with closed JSON Schemas and JSON-RPC 2.0 notifications
- Deterministic offline tests plus optional live Hermes and packed-artifact tests

## Install and verify

    npm install pyth-mcp
    npm test

`npm test` uses a local mock Hermes server and requires no external network.
Additional verification commands are:

    npm run test:packed   # pack, install with scripts disabled, and execute
    npm run test:live     # query the public Hermes API

## CLI quick start

    pyth-mcp init --root /path/to/project
    pyth-mcp list-prices BTC --root /path/to/project
    pyth-mcp get-price BTC/USD --root /path/to/project
    pyth-mcp get-price BTC/USD,ETH/USD --json --root /path/to/project
    pyth-mcp watch SOL/USD --interval 5000 --count 10 --root /path/to/project
    pyth-mcp mcp-start --root /path/to/project

All commands accept `--root DIR`; it defaults to the current directory. State
is stored under `.pyth-mcp/`. Use `--json` for machine-readable output. Watch
mode always fetches fresh updates and emits one result per polling interval;
`--count 0` continues until interrupted.

### Feed catalog

    pyth-mcp list-prices
    pyth-mcp list-prices ETH
    pyth-mcp list-prices AAPL --asset-type equity
    pyth-mcp list-prices USD --limit 100 --force-refresh

Catalog results include the feed id, full symbol, base and quote currencies,
asset type, and description. The default catalog TTL is one hour. An empty
query returns the first 50 catalog entries after client-side sorting.

### Latest prices

    pyth-mcp get-price BTC
    pyth-mcp get-price ETH/USD --force-refresh
    pyth-mcp get-price e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43
    pyth-mcp get-price BTC/USD,ETH/USD,SOL/USD --cache-ttl 60 --json

`BTC` and other built-in base symbols resolve to their USD feed. For other
assets, use a full catalog symbol when a base symbol is ambiguous. Cached
responses retain the original `fetchedAt` and set `cached: true`. A TTL of zero
disables price cache reads and writes for that request. Batch calls return
successful quotes in `prices` and per-feed failures in `errors`; a batch throws
only when no requested price can be returned.

## Configuration

    pyth-mcp config
    pyth-mcp config get cacheTtlMs
    pyth-mcp config set cacheTtlMs 60000
    pyth-mcp config set baseUrl https://hermes.pyth.network
    pyth-mcp config reset

| Key | Environment variable | Default | Meaning |
|---|---|---|---|
| `baseUrl` | `PYTH_BASE_URL` | `https://hermes.pyth.network` | Hermes API origin |
| `apiKey` | `PYTH_API_KEY` | empty | Bearer token required by current Hermes API policy |
| `timeoutMs` | `PYTH_TIMEOUT_MS` | `10000` | Per-request timeout |
| `cacheTtlMs` | `PYTH_CACHE_TTL_MS` | `30000` | Latest-price cache TTL |
| `catalogTtlMs` | `PYTH_CATALOG_TTL_MS` | `3600000` | Feed catalog cache TTL |
| `retries` | `PYTH_RETRIES` | `2` | Retries for 429, 5xx, and network errors |

`PYTH_ROOT` selects the project root when `--root` is not provided. Environment
values override the config file; explicit programmatic overrides take highest
precedence. URLs must use HTTP or HTTPS and cannot contain credentials. The
API key is sent only as `Authorization: Bearer ...`; CLI and public config
output redact it. Set `PYTH_API_KEY` before live price retrieval because Pyth
now requires an API key for Hermes price updates.

## MCP server

    pyth-mcp mcp-start --root /path/to/project

The server speaks newline-delimited JSON-RPC 2.0 over stdio and reserves stdout
for protocol messages. It negotiates MCP 2025-06-18, 2025-03-26, or 2024-11-05.
Notifications receive no response. Duplicate initialize requests are rejected.
The latest protocol rejects batch requests; older negotiated versions support
JSON-RPC batch arrays.

### Tools

| Tool | Purpose |
|---|---|
| `pyth_get_price` | Get one latest price, confidence interval, EMA, and publish time |
| `pyth_get_prices` | Get up to 100 prices with independent per-feed cache entries |
| `pyth_list_feeds` | Search the Hermes feed catalog with optional asset and limit filters |
| `pyth_resolve_feed` | Resolve a symbol or feed id to canonical feed metadata |
| `pyth_ping` | Check Hermes reachability with a small live request |

All tools have closed input schemas. Schema violations return `-32602`. Domain
failures such as an unknown feed, timeout, or upstream API error are returned
as tool results with `isError: true` and a structured error code.

## Programmatic API

    const { PythClient } = require('pyth-mcp');

    const client = new PythClient({ rootDir: process.cwd() });
    const feed = await client.resolveFeed('BTC/USD');
    const quote = await client.getPrice(feed.id);
    const batch = await client.getPrices(['BTC/USD', 'ETH/USD']);
    const catalog = await client.listFeeds({ query: 'SOL', limit: 10 });
    client.close();

Price values are available both as JavaScript numbers and exact decimal text.
The original integer strings remain under `raw`, so consumers do not need to
reconstruct values from floating-point numbers.

Pyth data is subject to Pyth Network's terms and Hermes rate limits. This
package retrieves oracle data only; it does not provide financial advice,
trading execution, or on-chain transaction submission.
