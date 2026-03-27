import { Request, Response } from 'express';
import { rateLimitMiddleware } from '../middleware/express';
import { IRateLimiter, RateLimitResult } from '../types';

const makeResult = (overrides: Partial<RateLimitResult> = {}): RateLimitResult => ({
  allowed: true,
  currentCount: 1,
  remaining: 9,
  resetTime: 1000,
  limit: 10,
  windowSeconds: 60,
  ...overrides,
});

const makeLimiter = (result: Partial<RateLimitResult> = {}): IRateLimiter =>
  ({ check: jest.fn().mockResolvedValue(makeResult(result)) } as unknown as IRateLimiter);

const makeReq = (overrides: Record<string, unknown> = {}): Request =>
  ({ path: '/test', headers: {}, socket: { remoteAddress: '1.2.3.4' }, ...overrides } as unknown as Request);

const makeRes = (): Response => {
  const res = { setHeader: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
  return res as unknown as Response;
};

describe('rateLimitMiddleware', () => {
  describe('allowed request', () => {
    it('calls next()', async () => {
      const next = jest.fn();
      await rateLimitMiddleware({ limiter: makeLimiter() })(makeReq(), makeRes(), next);
      expect(next).toHaveBeenCalledTimes(1);
    });

    it('does not send a response', async () => {
      const res = makeRes();
      await rateLimitMiddleware({ limiter: makeLimiter() })(makeReq(), res, jest.fn());
      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).not.toHaveBeenCalled();
    });

    it('attaches req.rateLimit with limit, remaining, reset, total', async () => {
      const req = makeReq();
      await rateLimitMiddleware({ limiter: makeLimiter({ limit: 10, remaining: 9, resetTime: 1234, currentCount: 1 }) })(req, makeRes(), jest.fn());
      expect((req as any).rateLimit).toEqual({ limit: 10, remaining: 9, reset: 1234, total: 1 });
    });
  });

  describe('denied request', () => {
    it('returns 429 status', async () => {
      const res = makeRes();
      await rateLimitMiddleware({ limiter: makeLimiter({ allowed: false }) })(makeReq(), res, jest.fn());
      expect(res.status).toHaveBeenCalledWith(429);
    });

    it('does not call next()', async () => {
      const next = jest.fn();
      await rateLimitMiddleware({ limiter: makeLimiter({ allowed: false }) })(makeReq(), makeRes(), next);
      expect(next).not.toHaveBeenCalled();
    });

    it('response body includes error, message, retryAfter', async () => {
      const res = makeRes();
      await rateLimitMiddleware({ limiter: makeLimiter({ allowed: false, limit: 10, windowSeconds: 60, retryAfter: 45 }) })(makeReq(), res, jest.fn());
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        error: 'Too Many Requests',
        retryAfter: 45,
      }));
    });
  });

  describe('headers', () => {
    it('sets X-RateLimit-Limit, Remaining, Reset on allowed request', async () => {
      const res = makeRes();
      await rateLimitMiddleware({ limiter: makeLimiter({ limit: 10, remaining: 9, resetTime: 1000 }) })(makeReq(), res, jest.fn());
      expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', 10);
      expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', 9);
      expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Reset', 1000);
    });

    it('sets Retry-After header when denied', async () => {
      const res = makeRes();
      await rateLimitMiddleware({ limiter: makeLimiter({ allowed: false, retryAfter: 30 }) })(makeReq(), res, jest.fn());
      expect(res.setHeader).toHaveBeenCalledWith('Retry-After', 30);
    });

    it('does not set Retry-After when allowed', async () => {
      const res = makeRes();
      await rateLimitMiddleware({ limiter: makeLimiter({ allowed: true }) })(makeReq(), res, jest.fn());
      expect(res.setHeader).not.toHaveBeenCalledWith('Retry-After', expect.anything());
    });

    it('does not set any headers when addHeaders is false', async () => {
      const res = makeRes();
      await rateLimitMiddleware({ limiter: makeLimiter(), addHeaders: false })(makeReq(), res, jest.fn());
      expect(res.setHeader).not.toHaveBeenCalled();
    });
  });

  describe('skipPaths', () => {
    it('calls next() without checking limiter for skipped path', async () => {
      const limiter = makeLimiter();
      const next = jest.fn();
      await rateLimitMiddleware({ limiter, skipPaths: ['/health'] })(makeReq({ path: '/health' }), makeRes(), next);
      expect(next).toHaveBeenCalled();
      expect(limiter.check).not.toHaveBeenCalled();
    });

    it('checks limiter for non-skipped path', async () => {
      const limiter = makeLimiter();
      await rateLimitMiddleware({ limiter, skipPaths: ['/health'] })(makeReq({ path: '/api/users' }), makeRes(), jest.fn());
      expect(limiter.check).toHaveBeenCalled();
    });
  });

  describe('default identifier extraction', () => {
    it('uses req.user.id → key is user:{id}', async () => {
      const limiter = makeLimiter();
      await rateLimitMiddleware({ limiter })(makeReq({ user: { id: 'u123' } }), makeRes(), jest.fn());
      expect(limiter.check).toHaveBeenCalledWith('user:u123', undefined);
    });

    it('uses x-user-id header when no req.user → key is user:{id}', async () => {
      const limiter = makeLimiter();
      await rateLimitMiddleware({ limiter })(makeReq({ headers: { 'x-user-id': 'u456' } }), makeRes(), jest.fn());
      expect(limiter.check).toHaveBeenCalledWith('user:u456', undefined);
    });

    it('falls back to ip when only x-api-key is present (not a supported identifier)', async () => {
      const limiter = makeLimiter();
      await rateLimitMiddleware({ limiter })(makeReq({ headers: { 'x-api-key': 'key-abc' } }), makeRes(), jest.fn());
      expect(limiter.check).toHaveBeenCalledWith('ip:1.2.3.4', undefined);
    });

    it('uses first IP from x-forwarded-for header → key is ip:{ip}', async () => {
      const limiter = makeLimiter();
      await rateLimitMiddleware({ limiter })(makeReq({ headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' } }), makeRes(), jest.fn());
      expect(limiter.check).toHaveBeenCalledWith('ip:1.2.3.4', undefined);
    });

    it('falls back to socket.remoteAddress → key is ip:{addr}', async () => {
      const limiter = makeLimiter();
      await rateLimitMiddleware({ limiter })(makeReq({ socket: { remoteAddress: '9.9.9.9' } }), makeRes(), jest.fn());
      expect(limiter.check).toHaveBeenCalledWith('ip:9.9.9.9', undefined);
    });

    it('falls back to ip:unknown when nothing available', async () => {
      const limiter = makeLimiter();
      await rateLimitMiddleware({ limiter })(makeReq({ socket: {} }), makeRes(), jest.fn());
      expect(limiter.check).toHaveBeenCalledWith('ip:unknown', undefined);
    });
  });

  describe('custom options', () => {
    it('uses custom identifierExtractor', async () => {
      const limiter = makeLimiter();
      await rateLimitMiddleware({ limiter, identifierExtractor: () => 'custom:id' })(makeReq(), makeRes(), jest.fn());
      expect(limiter.check).toHaveBeenCalledWith('custom:id', undefined);
    });

    it('calls custom onLimitReached when denied', async () => {
      const onLimitReached = jest.fn();
      const req = makeReq();
      const res = makeRes();
      await rateLimitMiddleware({ limiter: makeLimiter({ allowed: false }), onLimitReached })(req, res, jest.fn());
      expect(onLimitReached).toHaveBeenCalledWith(req, res, expect.objectContaining({ allowed: false }));
    });

    it('passes req.rateLimitConfig as customConfig to limiter.check', async () => {
      const limiter = makeLimiter();
      const req = makeReq({ rateLimitConfig: { limit: 5, windowSeconds: 30 } });
      await rateLimitMiddleware({ limiter })(req, makeRes(), jest.fn());
      expect(limiter.check).toHaveBeenCalledWith(expect.any(String), { limit: 5, windowSeconds: 30 });
    });
  });

  describe('error handling', () => {
    it('calls next() when limiter.check throws', async () => {
      const limiter = { check: jest.fn().mockRejectedValue(new Error('boom')) } as unknown as IRateLimiter;
      const next = jest.fn();
      await rateLimitMiddleware({ limiter })(makeReq(), makeRes(), next);
      expect(next).toHaveBeenCalled();
    });

    it('does not send a response when limiter.check throws', async () => {
      const limiter = { check: jest.fn().mockRejectedValue(new Error('boom')) } as unknown as IRateLimiter;
      const res = makeRes();
      await rateLimitMiddleware({ limiter })(makeReq(), res, jest.fn());
      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).not.toHaveBeenCalled();
    });
  });
});
