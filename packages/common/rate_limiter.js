function createRateLimiter({ windowMs = 60_000, max = 10, keyFn = req => req.ip || req.socket?.remoteAddress || 'unknown' } = {}) {
  const buckets = new Map();
  let lastCleanup = Date.now();
  return (req, res, next) => {
    const now = Date.now();
    if (now - lastCleanup > windowMs) {
      for (const [key, bucket] of buckets) {
        if (now - bucket.started >= windowMs) buckets.delete(key);
      }
      lastCleanup = now;
    }
    const key = String(keyFn(req));
    const bucket = buckets.get(key);
    if (!bucket || now - bucket.started >= windowMs) {
      buckets.set(key, { started: now, count: 1 });
      return next();
    }
    bucket.count += 1;
    if (bucket.count > max) {
      res.set('Retry-After', String(Math.ceil((windowMs - (now - bucket.started)) / 1000)));
      return res.status(429).json({ success: false, error: '请求过于频繁，请稍后再试' });
    }
    next();
  };
}

module.exports = { createRateLimiter };
