const crypto = require('crypto');

/**
 * 统一身份认证中间件（双端共享）
 *
 * - Token 使用 HMAC-SHA256 签名并携带过期时间，不可伪造、不可过期后继续使用
 * - 白名单方法直接放行；其余 API 必须携带有效 Bearer Token
 * - requireRole(role) 用于管理类接口的角色校验（admin / auditor / operator）
 */

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12 小时
const ASSET_TOKEN_TTL_MS = 10 * 60 * 1000; // 10 分钟，仅用于受保护图片

let tokenSecret = crypto.randomBytes(32).toString('hex');

function setTokenSecret(secret) {
  if (typeof secret === 'string' && secret.length >= 32) tokenSecret = secret;
}

function getTokenSecret() {
  return tokenSecret;
}

/**
 * 生成带过期时间的 HMAC 签名 Token
 */
function generateToken(user, options = {}) {
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : TOKEN_TTL_MS;
  const payload = {
    id: user.id,
    username: user.username,
    role: user.role,
    aud: options.audience || 'vfusion',
    scope: options.scope || 'api',
    iat: Date.now(),
    exp: Date.now() + ttlMs
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', getTokenSecret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

/**
 * 校验 Token，返回 payload 或 null
 */
function verifyToken(tokenStr, options = {}) {
  if (typeof tokenStr !== 'string' || !tokenStr.includes('.')) return null;
  const [body, sig, extra] = tokenStr.split('.');
  if (!body || !sig || extra) return null;
  const expectedSig = crypto.createHmac('sha256', getTokenSecret()).update(body).digest('base64url');

  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (typeof payload.iat !== 'number' || typeof payload.exp !== 'number' || payload.iat > Date.now() + 5000 || Date.now() > payload.exp) return null;
    if (options.audience && payload.aud !== options.audience) return null;
    const allowedScopes = Array.isArray(options.allowedScopes) && options.allowedScopes.length > 0
      ? options.allowedScopes
      : ['api'];
    if (!allowedScopes.includes(payload.scope || 'api')) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

/**
 * 认证中间件工厂。
 * @param {object} opts
 * @param {(id:number) => any|Promise<any>} [opts.loadUser] 根据 token 中的 id 回查用户（返回 {id,username,role,status}）
 * @param {string[]} [opts.skipPaths] 额外跳过校验的路径前缀（如 /api/auth/login）
 * @param {string[]} [opts.publicPaths] skipPaths 的别名，便于按端命名习惯调用
 */
function authMiddleware(opts = {}) {
  const {
    loadUser,
    skipPaths = [],
    publicPaths = [],
    audience,
    allowedScopes = ['api'],
    allowQueryToken = false
  } = opts;
  const exempt = new Set([...skipPaths, ...publicPaths]);

  return async (req, res, next) => {
    // 静态资源与离线地图瓦片放行
    const urlPath = req.path;
    if (urlPath.startsWith('/assets/') ||
        urlPath.startsWith('/collector-assets/') ||
        urlPath.startsWith('/api/map/tiles/') ||
        urlPath.startsWith('/map/tiles/') ||
        urlPath.startsWith('/storage/tiles/') ||
        urlPath === '/api/config/map' ||
        urlPath === '/config/map' ||
        urlPath.startsWith('/favicon') ||
        urlPath === '/') {
      return next();
    }
    // 登录接口与显式白名单放行
    if (urlPath === '/api/auth/login' || urlPath === '/auth/login' || exempt.has(urlPath)) return next();

    const header = req.headers.authorization || '';
    let token = null;
    if (header.startsWith('Bearer ')) {
      token = header.slice(7).trim();
    } else if (allowQueryToken && req.query) {
      const rawQuery = req.query.access_token || req.query.token;
      if (Array.isArray(rawQuery)) {
        token = typeof rawQuery[0] === 'string' ? rawQuery[0].trim() : null;
      } else if (typeof rawQuery === 'string') {
        token = rawQuery.trim();
      }
    }
    const decoded = verifyToken(token, { audience, allowedScopes });

    if (!decoded) {
      return res.status(401).json({ success: false, error: '未登录或 Token 已失效，请重新登录' });
    }

    // 回查用户，确保用户仍然存在且未被禁用
    if (loadUser) {
      try {
        const user = await loadUser(decoded.id);
        if (!user) return res.status(401).json({ success: false, error: '用户不存在，请重新登录' });
        if (user.status === 'DISABLED' || user.status === 'inactive' || user.status === 'disabled') {
          return res.status(403).json({ success: false, error: '账号已被禁用，请联系管理员' });
        }
        req.user = user;
      } catch (e) {
        return res.status(401).json({ success: false, error: '用户校验失败，请重新登录' });
      }
    } else {
      req.user = decoded;
    }
    next();
  };
}

function assetAuthMiddleware(opts = {}) {
  return authMiddleware({
    ...opts,
    allowQueryToken: true,
    allowedScopes: ['api', 'asset']
  });
}

/**
 * 角色校验中间件工厂
 */
function requireRole(...roles) {
  return (req, res, next) => {
    const rawRole = req.user && req.user.role;
    const role = rawRole === 'user' ? 'operator' : rawRole;
    if (role === 'admin' || roles.includes(role)) return next();
    return res.status(403).json({ success: false, error: '权限不足: 该操作需要管理员权限' });
  };
}

module.exports = {
  generateToken,
  verifyToken,
  setTokenSecret,
  getTokenSecret,
  authMiddleware,
  assetAuthMiddleware,
  requireRole,
  TOKEN_TTL_MS,
  ASSET_TOKEN_TTL_MS
};
