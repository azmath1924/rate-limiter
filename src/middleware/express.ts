import { Request, Response, NextFunction } from 'express';
import { IRateLimiter, RateLimitConfig, RateLimitResult } from '../types';

// Augment Express Request so consumers get typed access without casting.
declare global {
  namespace Express {
    interface Request {
      /** Populated by rateLimitMiddleware after every allowed request. */
      rateLimit?: {
        limit: number;
        remaining: number;
        reset: number;
        total: number;
      };
      /**
       * Set this on the request before the middleware runs to override the
       * default limit/window for a single request.
       */
      rateLimitConfig?: Partial<RateLimitConfig>;
      /** Populated by authentication middleware (e.g. Passport). */
      user?: { id?: string };
    }
  }
}

export interface ExpressMiddlewareOptions {
  limiter: IRateLimiter;
  /** Max requests allowed per window for this route. Overrides the limiter's defaultLimit. */
  limit?: number;
  /** Window duration in seconds for this route. Overrides the limiter's defaultWindow. */
  windowSeconds?: number;
  identifierExtractor?: (req: Request) => string;
  skipPaths?: string[];
  onLimitReached?: (req: Request, res: Response, result: RateLimitResult) => void;
  addHeaders?: boolean;
  logger?: Pick<Console, 'error'>;
}

export function rateLimitMiddleware(options: ExpressMiddlewareOptions) {
  const {
    limiter,
    limit,
    windowSeconds,
    identifierExtractor = defaultIdentifierExtractor,
    skipPaths = [],
    onLimitReached = defaultOnLimitReached,
    addHeaders = true,
    logger = console
  } = options;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (skipPaths.includes(req.path)) {
      next();
      return;
    }

    let result: RateLimitResult;

    try {
      const identifier = identifierExtractor(req);
      // Merge priority: req.rateLimitConfig (per-request) > route options > limiter defaults.
      // Only build the config object when at least one value is defined — passing an
      // all-undefined object is semantically equivalent to undefined but breaks call-site checks.
      const routeConfig = limit !== undefined || windowSeconds !== undefined
        ? { limit, windowSeconds }
        : undefined;
      const config = routeConfig ?? req.rateLimitConfig
        ? { ...routeConfig, ...req.rateLimitConfig }
        : undefined;
      result = await limiter.check(identifier, config);
    } catch (error) {
      logger.error('Rate limiter error:', error);
      next();
      return;
    }

    if (addHeaders) {
      addRateLimitHeaders(res, result);
    }

    req.rateLimit = {
      limit: result.limit,
      remaining: result.remaining,
      reset: result.resetTime,
      total: result.currentCount
    };

    if (!result.allowed) {
      try {
        onLimitReached(req, res, result);
      } catch (error) {
        logger.error('onLimitReached handler threw:', error);
        if (!res.headersSent) {
          defaultOnLimitReached(req, res, result);
        }
      }
      return;
    }

    next();
  };
}

function defaultIdentifierExtractor(req: Request): string {
  const userId = req.user?.id ?? req.headers['x-user-id'];
  if (userId && typeof userId === 'string') return `user:${userId}`;

  const forwarded = req.headers['x-forwarded-for'];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const rawIp = raw ? (raw.split(',')[0] ?? raw).trim() : req.socket.remoteAddress ?? 'unknown';
  const ip = rawIp === '::1' ? '127.0.0.1' : rawIp;
  return `ip:${ip}`;
}

function defaultOnLimitReached(_req: Request, res: Response, result: RateLimitResult): void {
  res.status(429).json({
    error: 'Too Many Requests',
    message: `Rate limit of ${result.limit} requests per ${result.windowSeconds} seconds exceeded`,
    retryAfter: result.retryAfter
  });
}

function addRateLimitHeaders(res: Response, result: RateLimitResult): void {
  res.setHeader('X-RateLimit-Limit', result.limit);
  res.setHeader('X-RateLimit-Remaining', result.remaining);
  res.setHeader('X-RateLimit-Reset', Math.ceil(result.resetTime));
  if (result.retryAfter) {
    res.setHeader('Retry-After', result.retryAfter);
  }
}
