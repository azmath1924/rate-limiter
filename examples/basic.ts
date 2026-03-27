import express from 'express';
import Redis from 'ioredis';
import {
  RateLimiter,
  RedisSlidingWindowStorage,
  RedisTokenBucketStorage,
  TokenBucketAlgorithm,
  rateLimitMiddleware,
} from '../src';

const app = express();
const port = 3000;

app.use(express.json());

// ─── Shared Redis client ──────────────────────────────────────────────────────

const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
});

// ─── Sliding window limiter ───────────────────────────────────────────────────
// Enforces an exact rolling window — no burst allowed beyond the limit.
// Suited for endpoints where consistent request rate matters (login, browsing).

const swLimiter = new RateLimiter({
  storage: new RedisSlidingWindowStorage(redis, 'example:'),
  defaultLimit: 100,
  defaultWindow: 60,
  failOpen: true,
});

// ─── Token bucket limiter ─────────────────────────────────────────────────────
// Allows short bursts up to capacity, then enforces a smooth refill rate.
// Suited for endpoints where a client may retry quickly then back off (checkout).

const tbLimiter = new RateLimiter({
  storage: new RedisTokenBucketStorage(redis, 'example:'),
  algorithm: new TokenBucketAlgorithm(),
  defaultLimit: 3,    // capacity — max 3 tokens in the bucket
  defaultWindow: 900, // refills fully in 15 minutes (1 token per 5 min)
  failOpen: false,    // checkout must enforce strictly
});

// ─── Routes ───────────────────────────────────────────────────────────────────

// Health — not rate limited
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', redis: redis.status });
});

// Product listing — sliding window, 100 req/min per IP
// Exact window ensures no burst spike can exceed the limit.
app.get('/api/products', rateLimitMiddleware({ limiter: swLimiter, addHeaders: true }), (_req, res) => {
  res.json({
    products: [
      { id: 1, name: 'Jacket', price: 129.99 },
      { id: 2, name: 'Boots',  price: 89.99  },
    ],
  });
});

// Login — sliding window, 5 attempts per 5 minutes per email (brute-force guard)
// Keyed by email so distributed across IP or not, the per-account limit holds.
app.post('/api/auth/login', rateLimitMiddleware({
  limiter: swLimiter,
  limit: 5,
  windowSeconds: 300,
  identifierExtractor: (req) => `login:${req.body.email ?? req.ip}`,
  onLimitReached: (_req, res, result) =>
    res.status(429).json({ error: 'Too many login attempts', retryAfter: result.retryAfter }),
}), (req, res) => {
  const { email, password } = req.body;
  if (email === 'demo@example.com' && password === 'password') {
    res.json({ token: 'demo-jwt' });
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

// Checkout — token bucket, 3 attempts per 15 minutes per user
// Allows a quick retry if payment fails transiently, then enforces a hard cool-down.
// failOpen: false — a Redis failure must not silently allow unlimited payment attempts.
app.post('/api/checkout', rateLimitMiddleware({
  limiter: tbLimiter,
  identifierExtractor: (req) => `checkout:${req.headers['x-user-id'] ?? req.ip}`,
  onLimitReached: (_req, res, result) =>
    res.status(429).json({ error: 'Too many checkout attempts', retryAfter: result.retryAfter }),
}), (req, res) => {
  const { items, paymentMethod } = req.body;
  res.json({
    orderId: `ORD-${Date.now()}`,
    items,
    paymentMethod,
    status: 'confirmed',
  });
});

// Search — token bucket, 20 capacity, refills in 60 seconds per user
// Full-text search is expensive — allow a natural burst (user refining a query quickly)
// then smooth out sustained hammering to ~1 search every 3 seconds.
// A sliding window would block the 21st rapid refinement even if the user then goes idle;
// the token bucket refills during that idle time, rewarding well-behaved clients.
const searchLimiter = new RateLimiter({
  storage: new RedisTokenBucketStorage(redis, 'example:'),
  algorithm: new TokenBucketAlgorithm(),
  defaultLimit: 20,   // capacity — up to 20 rapid searches in one burst
  defaultWindow: 60,  // refills fully in 60 s (~1 token per 3 s steady state)
  failOpen: true,
});

app.get('/api/search', rateLimitMiddleware({
  limiter: searchLimiter,
  identifierExtractor: (req) => `search:${req.headers['x-user-id'] ?? req.ip}`,
  addHeaders: true,
  onLimitReached: (_req, res, result) =>
    res.status(429).json({ error: 'Search rate limit exceeded', retryAfter: result.retryAfter }),
}), (req, res) => {
  const { q } = req.query;
  res.json({
    query: q,
    results: [
      { id: 1, name: 'Leather Jacket', price: 129.99 },
      { id: 2, name: 'Chelsea Boots',  price: 89.99  },
    ],
  });
});

// ─── Error handler ────────────────────────────────────────────────────────────

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ─── Start ────────────────────────────────────────────────────────────────────

const server = app.listen(port, () => {
  console.log(`\n Server running at http://localhost:${port}\n`);
  console.log(`  GET  /health                     health check`);
  console.log(`  GET  /api/products               100 req/min per IP    (sliding window)`);
  console.log(`  POST /api/auth/login             5 req/5 min per email (sliding window)`);
  console.log(`  POST /api/checkout               3 req/15 min per user (token bucket)`);
  console.log(`  GET  /api/search                 20 cap, refill 60s    (token bucket)\n`);
  console.log(`  # Browse products`);
  console.log(`  curl http://localhost:${port}/api/products\n`);
  console.log(`  # Login`);
  console.log(`  curl -X POST http://localhost:${port}/api/auth/login \\`);
  console.log(`    -H 'Content-Type: application/json' \\`);
  console.log(`    -d '{"email":"demo@example.com","password":"password"}'\n`);
  console.log(`  # Checkout`);
  console.log(`  curl -X POST http://localhost:${port}/api/checkout \\`);
  console.log(`    -H 'Content-Type: application/json' \\`);
  console.log(`    -H 'x-user-id: user-123' \\`);
  console.log(`    -d '{"items":[{"id":1,"qty":2}],"paymentMethod":"card"}'\n`);
  console.log(`  # Search`);
  console.log(`  curl -H 'x-user-id: user-123' 'http://localhost:${port}/api/search?q=jacket'\n`);
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────

function shutdown(signal: string) {
  console.log(`\n${signal} — shutting down`);
  server.close(() => {
    redis.disconnect();
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
