# Rate Limiter

Distributed rate limiter for Node.js — Redis-backed sliding window and token bucket, Express middleware, TypeScript.

## Quick Start

```bash
docker-compose up -d && npm install && npm run dev
```

```bash
npm test                   # unit tests (no Redis needed)
npm run test:integration   # requires Docker (run --runInBand to avoid Redis key collisions between suites)
```

---

## Architecture & Integration

This is a **Node.js library** — not a standalone service. Your application owns the Redis connection and the HTTP server; the library plugs into both.

```
  Your Application
         │
         ▼
    Middleware          HTTP layer — sets X-RateLimit-* headers, returns 429
         │
         ▼
    Rate Limiter        check / peek / reset / getMetrics
         │
         ▼
    Algorithm
    ├── Sliding Window  ──►  Redis sorted set   (one entry per request)
    └── Token Bucket    ──►  Redis hash         (tokens + last_refill)
                                    │
                                    ▼
                        Redis  ·  Sentinel  ·  Cluster
```

The algorithm and storage are paired at construction — passing a token bucket storage to a sliding window algorithm is a compile-time error, not a runtime surprise.

---

### Creating a limiter

Both algorithms support a **factory** (one-liner, manages the Redis connection) and **manual construction** (bring your own client, share across limiters).

**Sliding window — factory**
```typescript
import { createRateLimiter } from 'rate-limiter';

const limiter = createRateLimiter({
  redisUrl: 'redis://localhost:6379',
  defaultLimit: 100,
  defaultWindow: 60,  // seconds
});
```

**Sliding window — manual**
```typescript
import Redis from 'ioredis';
import { RateLimiter, RedisSlidingWindowStorage, SlidingWindowAlgorithm } from 'rate-limiter';

const client = new Redis('redis://localhost:6379');
const limiter = new RateLimiter({
  storage: new RedisSlidingWindowStorage(client, 'myapp:'),
  algorithm: new SlidingWindowAlgorithm(),
  defaultLimit: 100,
  defaultWindow: 60,
});
```

**Token bucket — factory**
```typescript
import { createTokenBucketRateLimiter } from 'rate-limiter';

const limiter = createTokenBucketRateLimiter({
  redisUrl: 'redis://localhost:6379',
  defaultLimit: 10,   // capacity (max tokens)
  defaultWindow: 1,   // seconds to refill full bucket
});
```

**Token bucket — manual**
```typescript
import Redis from 'ioredis';
import { RateLimiter, RedisTokenBucketStorage, TokenBucketAlgorithm } from 'rate-limiter';

const client = new Redis('redis://localhost:6379');
const limiter = new RateLimiter({
  storage: new RedisTokenBucketStorage(client, 'myapp:'),
  algorithm: new TokenBucketAlgorithm(),
  defaultLimit: 10,
  defaultWindow: 1,
});
```

> Manual construction is useful when two limiters share one Redis client (different key prefixes, same connection), or when you need full control over ioredis options.

---

### Using with Express

**Global — applies to every route:**
```typescript
import { rateLimitMiddleware } from 'rate-limiter';

app.use(rateLimitMiddleware({ limiter, skipPaths: ['/health'], addHeaders: true }));
```

**Per-route — set limit and window directly on the middleware:**
```typescript
app.post('/auth/login', rateLimitMiddleware({
  limiter,
  limit: 5,
  windowSeconds: 300,
  identifierExtractor: (req) => `login:${req.body.email}`,
  onLimitReached: (_req, res, result) =>
    res.status(429).json({ error: 'Too many attempts', retryAfter: result.retryAfter }),
}), loginHandler);
```

**Programmatic — no middleware needed:**
```typescript
const result = await limiter.check(`user:${userId}`);
if (!result.allowed) return res.status(429).json({ retryAfter: result.retryAfter });
```

**Other frameworks** (Fastify, Koa, NestJS) call `limiter.check()` directly — the Express middleware is a thin wrapper, not where the logic lives.

---

### Factory options

| Option | Type | Default | Description |
|---|---|---|---|
| `redis` | `Redis \| Cluster` | — | Pre-built ioredis client — takes precedence over all other options |
| `redisUrl` | `string` | — | Single-node URL e.g. `redis://localhost:6379` |
| `redisOptions` | `RedisOptions` | — | Host / port / password / db |
| `sentinel` | `SentinelConfig` | — | Sentinel config — automatic primary failover |
| `cluster` | `ClusterConfig` | — | Cluster config — automatic slot routing |
| `commandTimeout` | `number` | `500` | ms before a Redis command times out |
| `maxPendingCommands` | `number` | `100` | In-flight command cap — excess calls fail fast |
| `prefix` | `string` | `'ratelimit:'` | Key prefix for all Redis keys |
| `defaultLimit` | `number` | `100` | Requests allowed per window (or bucket capacity) |
| `defaultWindow` | `number` | `60` | Window in seconds (or seconds to refill full bucket) |
| `failOpen` | `boolean` | `true` | Allow traffic when Redis is unreachable |

---

## Approach

### Sliding window log

Each request is recorded as an entry in a Redis sorted set, scored by timestamp. On every check:

1. `ZREMRANGEBYSCORE` prunes entries older than the window
2. `ZCARD` reads the current count
3. `ZADD` writes the new entry if count < limit

All three steps execute inside a single Lua script — atomically, as one Redis command. Between steps 2 and 3 no other client can read or write the key. A pipeline cannot provide this guarantee.

Memory scales with traffic: one sorted-set entry per request, up to `limit` entries per key per window.

### Token bucket

Bucket state — `{tokens, last_refill}` — is stored in a Redis hash. On every check the Lua script:

1. Reads `tokens` and `last_refill` with `HMGET`
2. Computes `elapsed = now − last_refill` using `redis.call('TIME')`
3. Refills: `tokens = min(capacity, tokens + elapsed × refillRate)`
4. Consumes one token if `tokens ≥ 1`, otherwise denies
5. Writes the new state with `HSET`

Memory is always two fields per key — O(1) regardless of request volume or limit size.

### Atomicity via Lua

Both algorithms run their entire read-modify-write sequence as a single Lua script. Redis executes Lua scripts on its single thread with no command interleaving. Two concurrent requests hitting the same key are serialised by Redis — one runs to completion before the other starts. No application-level locking is needed.

### Shared clock via `redis.call('TIME')`

All timestamps are read inside the Lua script using `redis.call('TIME')`, not from the application host. Every instance — regardless of NTP drift or container clock differences — uses the same Redis clock. Clock skew across instances is structurally impossible.

### Script loading: EVALSHA + single-flight + NOSCRIPT recovery

On first use, each Lua script is loaded into Redis with `SCRIPT LOAD`, which returns a 40-byte SHA. All subsequent calls send only the SHA via `EVALSHA` instead of the full script text (~500 bytes per call).

Concurrent requests during cold start share a single load promise — only one `SCRIPT LOAD` is issued regardless of how many requests arrive simultaneously.

If Redis flushes its script cache (restart or `SCRIPT FLUSH`), the next call gets a `NOSCRIPT` error. The recovery chain:

```
EVALSHA → NOSCRIPT → reload → retry EVALSHA → [still fails] → eval() → async SHA restore
```

No request is dropped. The cost is one extra round-trip for the requests in flight at the moment of the flush.

### Backpressure and queue bounding

Two mechanisms prevent the ioredis internal queue from growing without bound under Redis pressure:

**On disconnect** — `enableOfflineQueue: false` makes commands fail immediately rather than queue behind a reconnect. Failures route to `failOpen`.

**On slow Redis** — an in-flight command counter rejects new commands once `maxPendingCommands` (default 100) are already waiting. This converts a sustained latency spike into bounded fast failures rather than unbounded memory growth.

### Redis topology

The Lua scripts access only `KEYS[1]` — one key per call — making them cluster-safe (all accessed keys are always in the same hash slot). The factory supports single-node, Sentinel, and Cluster connections. After a Sentinel failover the new primary has no cached scripts; the NOSCRIPT recovery chain handles this within one extra round-trip, transparent to the caller.

---

## Trade-offs Considered

**Sliding window log vs. fixed window counter.** A fixed window counter is O(1) and trivial to implement, but allows a 2× burst straddling the reset point — a user can exhaust one window and immediately exhaust the next. The sliding window log is exact at the cost of O(limit) memory per key. For an e-commerce platform where limit violations carry real consequences (payments, checkout), correctness matters more than saving a few KB of Redis memory.

**Lua script vs. pipeline for atomicity.** A pipeline sends multiple commands in one round-trip but does not prevent interleaving — two concurrent requests can both read the same count before either writes, both passing when only one should. Lua executes as a single Redis command with no interleaving possible. The concurrency guarantee is structural, not something that needs to be reasoned about per deployment.

**Redis as the datastore.** Rate limiting state needs to be shared across all instances behind the load balancer — in-memory state per process would let users exceed the limit by spreading requests across instances. Redis is the natural fit: it's single-threaded (so Lua atomicity holds), fast enough that the rate limit check adds <1ms to a request, and already present in most production stacks. The alternative (a relational DB with row locks) would be slower and harder to expire keys automatically.

**Fail-open on Redis failure.** When Redis is unreachable, the limiter allows traffic through rather than blocking it. A Redis outage should not take down checkout. The downside is that during an outage, rate limits are not enforced — a bad actor could exploit the window. Endpoints where that is unacceptable (login, payment submission) should use `failOpen: false` explicitly.

**Token bucket included, not the default.** Token bucket is strictly better on memory (O(1) vs O(limit)) and handles burst-then-idle traffic more naturally. It is not the default because sliding window maps directly to "N requests per M seconds" — the mental model is simpler and the limit is easier to audit. Both are available; the right choice depends on the endpoint.

---

## What I'd Change With More Time

### Scalability

**Redis Cluster — horizontal scale.** The factory already supports Cluster connections and the Lua scripts are cluster-safe (single key per call). What's missing is a validated topology at load: integration tests that spin up a three-node Cluster via Docker Compose, run concurrent rate limit checks across all nodes, and assert that limits are enforced globally despite slot routing. Without that, Cluster support is wired but unproven under real distribution.

**Redis Sentinel — high availability.** Sentinel support is implemented and the NOSCRIPT recovery chain handles the script-cache gap after a failover. What's missing is a failover integration test: promote a replica mid-test while requests are in flight and assert that no requests are double-admitted and no limits are silently skipped. This requires a Compose setup with one primary, one replica, and three sentinel processes.

**Sliding window counter for high-limit workloads.** The sorted-set log holds one entry per request — at 10,000 req/min per user, that's 10,000 members per key. A two-bucket counter (current window + previous window, weighted overlap) would reduce this to two fixed fields per key at the cost of a small approximation error at window boundaries (~1–2% overage). Worth adding as an opt-in algorithm for workloads where memory per key is the constraint.

**Read replicas for `peek()`.** In read-heavy deployments (dashboards, status polling), `peek()` calls could be routed to a replica to offload the primary. This requires flagging the peek Lua script as read-only so ioredis routes it correctly under `scaleReads: 'slave'`.

---

### Observability

**Structured metrics.** There are no counters today. The first thing any on-call engineer will want when the limiter behaves unexpectedly is a dashboard. The following counters cover it:

| Metric | What it tells you |
|---|---|
| `ratelimit.allowed_total` | Baseline request throughput through the limiter |
| `ratelimit.denied_total` | How often limits are actually being hit |
| `ratelimit.storage_error_total` | Redis failures triggering fail-open |
| `ratelimit.failopen_total` | Requests that bypassed the check due to Redis being unavailable |
| `ratelimit.redis_latency_ms` | p50/p95/p99 of Redis round-trip time |

These should be emitted as OpenTelemetry counters and histograms so they land in whatever monitoring stack the application already uses (Datadog, Prometheus, CloudWatch) without coupling the library to any specific vendor.

**Distributed tracing.** Each `check()` call should emit a span with the identifier, limit, window, result (allowed/denied), and remaining tokens. This makes it possible to correlate a rate limit denial with the upstream request that triggered it — essential for debugging checkout failures or payment rejections at scale.

**Alerting baselines.** Two alerts worth defining from day one:
- `ratelimit.storage_error_total` rising → Redis is degraded, fail-open is active, limits are not being enforced
- `ratelimit.denied_total` spike on a specific identifier → either a legitimate traffic surge or an abusive client; needs human review

---

### Operational Hardening

**Dynamic limit configuration.** Limits are set at construction time. In production, you want to be able to tighten limits on a specific endpoint or user tier without a deploy — for example, dropping the checkout limit from 100 to 10 during a flash sale. This requires storing limits in Redis or a config service and reloading them on each check, with a short TTL cache to avoid a Redis lookup on every request.

**Graceful Redis reconnection backoff.** ioredis retries connections on disconnect with exponential backoff. Under a prolonged outage this can generate a thundering herd of reconnection attempts from every instance simultaneously. A jittered backoff strategy (full jitter or decorrelated jitter) would spread reconnection attempts across instances and reduce pressure on Redis at the moment it recovers.

**Admin API.** No management interface today. A minimal admin layer would expose: reset a specific identifier's counter, inspect current state for any key, and adjust per-identifier overrides without a deploy. Useful for support workflows (clearing a locked-out customer) and incident response (manually exempting a known-good IP during an investigation).
