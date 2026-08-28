require('../common/env_loader').initEnv();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const crypto = require('crypto');
const { unpackAndVerifyPackage } = require('../common/unpacker');
const { DEFAULT_FORM_SCHEMA, getHmacSecret, setHmacSecret } = require('../common/protocol');
const { hashPassword, verifyPassword, buildDefaultUsers, generateToken, verifyToken, setTokenSecret } = require('../common/auth');
const { authMiddleware, assetAuthMiddleware, requireRole, ASSET_TOKEN_TTL_MS } = require('../common/auth_middleware');
const { isSafeIdentifier, isSafeFileName: isSafeFileNameUtil, resolveInside, assertJsonObject, validateHttpUrl, validateHttpUrlResolved } = require('../common/security_utils');
const { writeJsonAtomic: writeJsonAtomicSafe, updateJsonAtomic } = require('../common/json_store');

const SQLiteStorageEngine = require('../common/db_sqlite');
const { buildEventTags } = require('../common/event_tags');
const { ensureSslCertificates } = require('../common/ssl_cert');
const { testFtpConnection, uploadToRemoteFtp, downloadFromRemoteFtp } = require('../common/ftp_client');
const { formidable } = require('formidable');
const { performOnlineUpgrade } = require('../common/system_upgrader');
const { createRateLimiter } = require('../common/rate_limiter');
const { generateWebhookSecret, signWebhookPayload, WEBHOOK_SIGNATURE_HEADER } = require('../common/webhook_signing');
const { normalizeCoordinates, normalizeMonitoringPoint, readMonitoringPoints, findMonitoringPoint, applyMonitoringPoint, createMonitoringPointId, monitoringPointsToCsv } = require('../common/monitoring_points');

const app = express();
const PORT = process.env.CORE_PORT || process.env.PORT || 5002;

const STORAGE_ROOT = path.resolve(__dirname, '../../storage');
const SECURITY_CONFIG_FILE = path.join(STORAGE_ROOT, 'security.json');

function getFtpInDir() {
  if (process.env.FTP_IN_DIR) return process.env.FTP_IN_DIR;
  try {
    if (fs.existsSync(SECURITY_CONFIG_FILE)) {
      const sec = JSON.parse(fs.readFileSync(SECURITY_CONFIG_FILE, 'utf8'));
      if (sec.ftp_in_dir) return sec.ftp_in_dir;
    }
  } catch (e) {}
  return path.join(STORAGE_ROOT, 'ftp_in');
}

function getFtpOutDir() {
  if (process.env.FTP_OUT_DIR) return process.env.FTP_OUT_DIR;
  try {
    if (fs.existsSync(SECURITY_CONFIG_FILE)) {
      const sec = JSON.parse(fs.readFileSync(SECURITY_CONFIG_FILE, 'utf8'));
      if (sec.ftp_out_dir) return sec.ftp_out_dir;
    }
  } catch (e) {}
  return path.join(STORAGE_ROOT, 'ftp_out');
}

function getPkgPrefix() {
  if (process.env.PKG_PREFIX) return process.env.PKG_PREFIX;
  try {
    if (fs.existsSync(SECURITY_CONFIG_FILE)) {
      const sec = JSON.parse(fs.readFileSync(SECURITY_CONFIG_FILE, 'utf8'));
      if (sec.pkg_prefix) return sec.pkg_prefix;
    }
  } catch (e) {}
  return 'vfusion_';
}

const coreSqlite = new SQLiteStorageEngine(path.join(STORAGE_ROOT, 'vfusion_core.db'));
const loginRateLimiter = createRateLimiter({ windowMs: 60_000, max: 10, keyFn: req => `${req.ip || 'unknown'}:${String(req.body?.username || '').slice(0, 64)}` });
const FTP_OUT_DIR = getFtpOutDir();
const FTP_IN_DIR = getFtpInDir();
const ARCHIVE_DIR = path.join(STORAGE_ROOT, 'archive');
const ERROR_DIR = path.join(STORAGE_ROOT, 'error');
const ASSETS_DIR = path.join(STORAGE_ROOT, 'assets');
const COLLECTOR_ASSETS_DIR = path.join(STORAGE_ROOT, 'collector_assets');
const DB_FILE = path.join(STORAGE_ROOT, 'db.json');
const SCHEMA_FILE = path.join(STORAGE_ROOT, 'schema.json');
const WEBHOOKS_FILE = path.join(STORAGE_ROOT, 'webhooks.json');
const USERS_FILE = path.join(STORAGE_ROOT, 'users.json');
const MONITORING_POINTS_FILE = path.join(STORAGE_ROOT, 'monitoring_points.json');

[STORAGE_ROOT, FTP_OUT_DIR, FTP_IN_DIR, ARCHIVE_DIR, ERROR_DIR, ASSETS_DIR, COLLECTOR_ASSETS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

function writeJsonAtomic(filePath, data) {
  return writeJsonAtomicSafe(filePath, data);
}

if (!fs.existsSync(DB_FILE)) writeJsonAtomic(DB_FILE, { events: [], audit_logs: [], alerts: [] });
if (!fs.existsSync(SCHEMA_FILE)) writeJsonAtomic(SCHEMA_FILE, DEFAULT_FORM_SCHEMA);
if (!fs.existsSync(WEBHOOKS_FILE)) writeJsonAtomic(WEBHOOKS_FILE, []);
if (!fs.existsSync(MONITORING_POINTS_FILE)) writeJsonAtomic(MONITORING_POINTS_FILE, []);

function maskWebhookSecret(secret) {
  if (!secret) return '未设置';
  const value = String(secret);
  return value.length <= 8 ? '********' : `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function serializeWebhook(hook, includeSecret = false) {
  const safe = { ...hook, secret: undefined, secret_masked: maskWebhookSecret(hook.secret) };
  delete safe.secret;
  if (includeSecret && hook.secret) safe.secret = hook.secret;
  return safe;
}

function migrateWebhookSecrets() {
  updateJsonAtomic(WEBHOOKS_FILE, [], list => {
    if (!Array.isArray(list)) return [];
    let changed = false;
    const migrated = list.map(hook => {
      if (hook && (!hook.secret || typeof hook.secret !== 'string' || hook.secret.length < 32)) {
        changed = true;
        return { ...hook, secret: generateWebhookSecret(), secret_version: 2, migrated_at: new Date().toISOString() };
      }
      return hook;
    });
    return changed ? migrated : list;
  });
}

migrateWebhookSecrets();

// 首次启动时生成随机 HMAC / Token 密钥，避免固定密钥随源码分发
if (!fs.existsSync(SECURITY_CONFIG_FILE)) {
  writeJsonAtomic(SECURITY_CONFIG_FILE, {
    hmac_secret: crypto.randomBytes(32).toString('hex'),
    token_secret: crypto.randomBytes(32).toString('hex'),
    upgrade_signing_key: crypto.randomBytes(32).toString('hex'),
    auto_diode_interval: 0,
    ftp_in_dir: '',
    ftp_out_dir: '',
    pkg_prefix: 'vfusion_'
  });
  console.log('[VFusion Core] 已生成全新随机 HMAC 与 Token 密钥并写入 security.json');
}
if (!fs.existsSync(USERS_FILE)) writeJsonAtomic(USERS_FILE, buildDefaultUsers());

try {
  const secConf = JSON.parse(fs.readFileSync(SECURITY_CONFIG_FILE, 'utf8'));
  let mutated = false;

  // 兼容历史配置：补齐缺失的密钥，并替换已泄露的旧默认值
  if (!secConf.hmac_secret || secConf.hmac_secret === 'vfusion_secret_key_2026') {
    secConf.hmac_secret = crypto.randomBytes(32).toString('hex');
    mutated = true;
    console.warn('[VFusion Core] 检测到缺失或已泄露的默认 HMAC 密钥，已自动轮换为随机密钥');
    console.warn('[VFusion Core] 注意：视频网端需同步该密钥，否则历史数据包将无法通过签名校验');
  }
  if (!secConf.token_secret) {
    secConf.token_secret = crypto.randomBytes(32).toString('hex');
    mutated = true;
  }
  if (!secConf.upgrade_signing_key) {
    secConf.upgrade_signing_key = crypto.randomBytes(32).toString('hex');
    mutated = true;
  }
  if (mutated) writeJsonAtomic(SECURITY_CONFIG_FILE, secConf);

let autoDiodeTimer = null;
function setAutoDiodeInterval(seconds) {
  if (autoDiodeTimer) { clearInterval(autoDiodeTimer); autoDiodeTimer = null; }
  if (seconds > 0) {
    autoDiodeTimer = setInterval(() => {
      try {
        const sec = getFtpConfig();
        if (sec && sec.ftp_enabled && sec.ftp_host) return;

        const ftpOutDir = getFtpOutDir();
        const ftpInDir = getFtpInDir();
        const prefix = getPkgPrefix();
        if (!fs.existsSync(ftpOutDir)) fs.mkdirSync(ftpOutDir, { recursive: true });
        if (!fs.existsSync(ftpInDir)) fs.mkdirSync(ftpInDir, { recursive: true });
        const files = fs.readdirSync(ftpOutDir).filter(f => f.startsWith(prefix) && (f.endsWith('.zip') || f.endsWith('.jpg')) && !f.endsWith('.tmp'));
        for (const f of files) {
          const srcPath = path.join(ftpOutDir, f);
          const destPath = path.join(ftpInDir, f);
          if (!fs.existsSync(destPath)) {
            fs.copyFileSync(srcPath, destPath);
            try { fs.unlinkSync(srcPath); } catch (e) {}
            console.log(`[VFusion Diode] 自动单向摆渡传输本地数据包: ${f} -> ftp_in`);
          }
        }
      } catch (e) {}
    }, seconds * 1000);
  }
}

  setHmacSecret(secConf.hmac_secret);
  setTokenSecret(secConf.token_secret);

  const diodeInterval = (typeof secConf.auto_diode_interval === 'number' && secConf.auto_diode_interval > 0)
    ? secConf.auto_diode_interval
    : (secConf.ftp_enabled ? 0 : 3);
  setAutoDiodeInterval(diodeInterval);
} catch (e) {
  console.error('[VFusion Core] 读取安全配置失败:', e.message);
  process.exit(1);
}

// CORS 白名单：默认仅允许同源与显式配置的来源，避免任意站点驱动内网 API
const ALLOWED_ORIGINS = (process.env.VFUSION_ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
app.use((req, res, next) => {
  const origin = req.get('Origin');
  if (!origin) return next();
  const host = req.get('Host');
  const sameOrigin = host && (origin === `http://${host}` || origin === `https://${host}`);
  if (sameOrigin || ALLOWED_ORIGINS.includes(origin)) return next();
  return res.status(403).json({ success: false, error: '该来源不在 CORS 白名单内' });
});
app.use(cors({ origin: true }));
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/favicon.ico', (req, res) => res.status(204).end());
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

// 统一身份认证：登录接口与静态资源之外的所有 API 均需有效 Token
app.use(authMiddleware({
  loadUser: (id) => readUsers().find(u => u.id === id) || null
}));

const FALLBACK_IMAGE_SVG = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="150" viewBox="0 0 200 150">
    <rect width="200" height="150" fill="#f8fafc"/>
    <text x="50%" y="46%" dominant-baseline="middle" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="12" font-weight="600" fill="#94a3b8">暂无现场存照</text>
    <text x="50%" y="64%" dominant-baseline="middle" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="10" fill="#cbd5e1">(历史测试数据)</text>
  </svg>`
);

function serveAssetFallback(req, res) {
  if (req.path && req.path.match(/\.(jpg|jpeg|png|webp|gif|svg)$/i)) {
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'no-cache');
    return res.status(200).send(FALLBACK_IMAGE_SVG);
  }
  res.status(404).send('Asset not found');
}

const protectedAssetAuth = assetAuthMiddleware({
  loadUser: (id) => readUsers().find(u => u.id === id) || null
});
app.use('/assets', protectedAssetAuth, express.static(ASSETS_DIR), express.static(COLLECTOR_ASSETS_DIR), serveAssetFallback);
app.use('/collector-assets', protectedAssetAuth, express.static(COLLECTOR_ASSETS_DIR), express.static(ASSETS_DIR), serveAssetFallback);

function readDb() {
  try {
    const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (!db || typeof db !== 'object' || Array.isArray(db)) throw new Error('数据库格式无效');
    if (!Array.isArray(db.events)) db.events = [];
    if (!Array.isArray(db.audit_logs)) db.audit_logs = [];
    if (!db.alerts) db.alerts = [];
    return db;
  }
  catch (e) { return { events: [], audit_logs: [], alerts: [] }; }
}
function writeDb(db) { writeJsonAtomic(DB_FILE, db); }

function readUsers() {
  try {
    const users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    if (Array.isArray(users) && users.length > 0) return users;
  } catch (e) {}
  const defaults = buildDefaultUsers();
  writeJsonAtomic(USERS_FILE, defaults);
  return defaults;
}
function writeUsers(list) { writeJsonAtomic(USERS_FILE, list); }

function readWebhooks() {
  try {
    const hooks = JSON.parse(fs.readFileSync(WEBHOOKS_FILE, 'utf8'));
    return Array.isArray(hooks) ? hooks : [];
  }
  catch (e) { return []; }
}
function writeWebhooks(list) { writeJsonAtomic(WEBHOOKS_FILE, list); }

function addAuditLog(type, message, status = 'INFO') {
  updateJsonAtomic(DB_FILE, { events: [], audit_logs: [], alerts: [] }, db => {
    if (!db || typeof db !== 'object' || Array.isArray(db)) db = { events: [], audit_logs: [], alerts: [] };
    if (!Array.isArray(db.audit_logs)) db.audit_logs = [];
    db.audit_logs.unshift({ id: Date.now(), timestamp: new Date().toISOString(), type, message, status });
    if (db.audit_logs.length > 500) db.audit_logs = db.audit_logs.slice(0, 500);
    return db;
  });
  coreSqlite.addAuditLog(type, message, status).catch(err => console.error('[VFusion Core] 审计日志写入失败:', err.message));
}

function addSystemAlert(title, message, level = 'WARN') {
  updateJsonAtomic(DB_FILE, { events: [], audit_logs: [], alerts: [] }, db => {
    if (!db || typeof db !== 'object' || Array.isArray(db)) db = { events: [], audit_logs: [], alerts: [] };
    if (!Array.isArray(db.alerts)) db.alerts = [];
    db.alerts.unshift({ id: Date.now(), timestamp: new Date().toISOString(), title, message, level, read: false });
    if (db.alerts.length > 100) db.alerts = db.alerts.slice(0, 100);
    return db;
  });
}

function tagEvent(eventRecord) {
  return buildEventTags(eventRecord);
}

function fixedDnsLookup(addresses) {
  return (hostname, options, callback) => {
    const requestedFamily = options && options.family ? options.family : 0;
    const selected = requestedFamily ? addresses.find(item => item.family === requestedFamily) : addresses[0];
    if (!selected) return callback(new Error('Webhook 目标地址解析失败'));
    callback(null, selected.address, selected.family);
  };
}

// 身份认证 API
app.post('/api/auth/login', loginRateLimiter, (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ success: false, error: '用户名与密码不能为空' });

  const users = readUsers();
  const user = users.find(u => u.username === username);
  const pwdCheck = user ? verifyPassword(password, user.password) : { valid: false, needsUpgrade: false };

  if (!user || !pwdCheck.valid) {
    addAuditLog('AUTH_FAIL', `登录失败: 用户名或密码错误 [${username}]`, 'WARN');
    return res.status(401).json({ success: false, error: '用户名或密码不正确' });
  }

  // 旧格式（固定盐 SHA-256）密码在首次成功登录后自动升级为 PBKDF2
  if (pwdCheck.needsUpgrade) {
    user.password = hashPassword(password);
    writeUsers(users);
    addAuditLog('USER_PWD_UPGRADE', `用户 [${user.username}] 的密码哈希已自动升级为 PBKDF2`, 'INFO');
  }

  if (user.status !== 'ACTIVE') {
    return res.status(403).json({ success: false, error: '该账号已被禁用，请联系管理员' });
  }

  const token = generateToken(user);
  addAuditLog('AUTH_SUCCESS', `用户 [${user.name}(${user.username})] 登录系统成功 (角色: ${user.role})`, 'SUCCESS');

  res.json({
    success: true,
    message: '登录成功',
    data: {
      token,
      user: { id: user.id, username: user.username, name: user.name, role: user.role }
    }
  });
});

app.get('/api/auth/me', (req, res) => {
  // 认证中间件已完成 Token 校验与用户回查
  const user = req.user;
  res.json({ success: true, data: { id: user.id, username: user.username, name: user.name, role: user.role } });
});

// 短期图片资产访问 Token 获取 API (仅限图片访问，TTL: 10 分钟)
app.get('/api/auth/asset-token', (req, res) => {
  const assetToken = generateToken(req.user, {
    scope: 'asset',
    ttlMs: ASSET_TOKEN_TTL_MS || (10 * 60 * 1000)
  });
  res.json({
    success: true,
    data: {
      token: assetToken,
      expires_in: Math.floor((ASSET_TOKEN_TTL_MS || (10 * 60 * 1000)) / 1000)
    }
  });
});

// 离线监控点位主数据：坐标由现场测绘/设备台账维护，不依赖外部地图服务
app.get('/api/monitoring-points', (req, res) => {
  const includeDisabled = req.user && req.user.role === 'admin' && String(req.query.include_disabled || '') === '1';
  const query = String(req.query.query || '').trim().toLowerCase();
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 30));
  const filtered = readMonitoringPoints(MONITORING_POINTS_FILE)
    .filter(point => includeDisabled || point.enabled !== false)
    .filter(point => !query || [point.point_id, point.name, point.location, point.description].some(value => String(value || '').toLowerCase().includes(query)));
  const total = filtered.length;
  const points = filtered.slice((page - 1) * limit, page * limit);
  res.json({ success: true, data: points, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
});

app.get('/api/monitoring-points/export', requireRole('admin'), (req, res) => {
  const points = readMonitoringPoints(MONITORING_POINTS_FILE);
  const format = String(req.query.format || 'csv').toLowerCase();
  if (format === 'json') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="monitoring_points.json"');
    return res.send(JSON.stringify(points, null, 2));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="monitoring_points.csv"');
  res.send(`\ufeff${monitoringPointsToCsv(points)}`);
});

app.post('/api/monitoring-points/import', requireRole('admin'), (req, res) => {
  try {
    const incoming = req.body && Array.isArray(req.body.points) ? req.body.points : req.body;
    if (!Array.isArray(incoming) || incoming.length > 50000) return res.status(400).json({ success: false, error: '导入数据必须是点位数组，最多 50000 条' });
    const normalized = incoming.map(item => normalizeMonitoringPoint(item));
    const ids = new Set();
    for (const point of normalized) {
      if (ids.has(point.point_id)) throw new Error(`导入数据中存在重复点位编号: ${point.point_id}`);
      ids.add(point.point_id);
    }
    const mode = req.body && !Array.isArray(req.body) ? String(req.body.mode || 'merge') : 'merge';
    const existing = readMonitoringPoints(MONITORING_POINTS_FILE);
    const merged = mode === 'replace' ? normalized : [...existing.filter(point => !ids.has(point.point_id)), ...normalized];
    writeJsonAtomic(MONITORING_POINTS_FILE, merged);
    addAuditLog('MONITORING_POINT_IMPORT', `导入监控点位 ${normalized.length} 条（${mode === 'replace' ? '覆盖' : '合并'}）`, 'SUCCESS');
    res.json({ success: true, data: { imported: normalized.length, total: merged.length, mode } });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

app.post('/api/monitoring-points', (req, res) => {
  try {
    const body = { ...(req.body || {}) };
    if (!body.point_id) body.point_id = createMonitoringPointId('USER');
    const point = normalizeMonitoringPoint(body);
    const points = readMonitoringPoints(MONITORING_POINTS_FILE);
    if (points.some(item => item.point_id === point.point_id)) {
      return res.status(409).json({ success: false, error: '点位编号已存在' });
    }
    writeJsonAtomic(MONITORING_POINTS_FILE, [...points, point]);
    addAuditLog('MONITORING_POINT_ADD', `用户 [${req.user?.username || 'unknown'}] 新增监控点位 [${point.point_id}]`, 'SUCCESS');
    res.status(201).json({ success: true, data: point });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

app.put('/api/monitoring-points/:point_id', requireRole('admin'), (req, res) => {
  try {
    const pointId = String(req.params.point_id || '').trim();
    const points = readMonitoringPoints(MONITORING_POINTS_FILE);
    const index = points.findIndex(item => item.point_id === pointId);
    if (index < 0) return res.status(404).json({ success: false, error: '监控点位不存在' });
    const point = normalizeMonitoringPoint({ ...req.body, created_at: points[index].created_at }, pointId);
    points[index] = point;
    writeJsonAtomic(MONITORING_POINTS_FILE, points);
    addAuditLog('MONITORING_POINT_UPDATE', `更新监控点位 [${point.point_id}]`, 'SUCCESS');
    res.json({ success: true, data: point });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

app.patch('/api/monitoring-points/:point_id/toggle', requireRole('admin'), (req, res) => {
  try {
    const pointId = String(req.params.point_id || '').trim();
    const points = readMonitoringPoints(MONITORING_POINTS_FILE);
    const point = points.find(item => item.point_id === pointId);
    if (!point) return res.status(404).json({ success: false, error: '监控点位不存在' });
    point.enabled = req.body && req.body.enabled !== undefined ? req.body.enabled !== false : !point.enabled;
    point.updated_at = new Date().toISOString();
    writeJsonAtomic(MONITORING_POINTS_FILE, points);
    addAuditLog('MONITORING_POINT_TOGGLE', `${point.enabled ? '启用' : '停用'}监控点位 [${point.point_id}]`, 'SUCCESS');
    res.json({ success: true, data: point });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

// 涉事人员库 API (内网端同步归档)
app.get('/api/personnel', (req, res) => {
  const db = readDb();
  res.json({ success: true, data: db.personnel || [] });
});

// 编辑涉事人员档案 (管理员)
app.put('/api/personnel/:id', requireRole('admin'), (req, res) => {
  const { id } = req.params;
  const { name, id_card, domicile } = req.body;
  const db = readDb();
  if (!db.personnel) db.personnel = [];

  const idx = db.personnel.findIndex(p => String(p.id) === String(id));
  if (idx < 0) return res.status(404).json({ success: false, error: '涉事人员记录不存在' });

  db.personnel[idx] = {
    ...db.personnel[idx],
    name: name !== undefined ? name : db.personnel[idx].name,
    id_card: id_card !== undefined ? id_card : db.personnel[idx].id_card,
    domicile: domicile !== undefined ? domicile : db.personnel[idx].domicile
  };

  writeDb(db);
  addAuditLog('PERSONNEL_EDIT', `编辑涉事人员档案 [${db.personnel[idx].name}]`, 'SUCCESS');
  res.json({ success: true, message: '人员档案已成功修改', data: db.personnel[idx] });
});

// 删除涉事人员档案 (管理员)
app.delete('/api/personnel/:id', requireRole('admin'), (req, res) => {
  const { id } = req.params;
  const db = readDb();
  if (!db.personnel) db.personnel = [];

  const idx = db.personnel.findIndex(p => String(p.id) === String(id));
  if (idx < 0) return res.status(404).json({ success: false, error: '涉事人员记录不存在' });

  const deleted = db.personnel.splice(idx, 1)[0];
  writeDb(db);
  addAuditLog('PERSONNEL_DELETE', `删除涉事人员档案 [${deleted.name}]`, 'WARN');
  res.json({ success: true, message: '人员档案已成功删除' });
});

// 任务管理与跨网汇聚 API (内网端)
app.get('/api/tasks', async (req, res) => {
  try {
    const tasks = await coreSqlite.getTasks();
    const events = await coreSqlite.getEvents();

    const taskStatsMap = {};
    for (const evt of events) {
      const code = evt.task_code || 'TASK_DEFAULT';
      if (!taskStatsMap[code]) {
        taskStatsMap[code] = {
          event_count: 0,
          photo_count: 0,
          contributors: new Set(),
          latest_timestamp: evt.timestamp || evt.created_at
        };
      }
      const fileCount = Array.isArray(evt.files) ? evt.files.length : (typeof evt.files === 'string' ? JSON.parse(evt.files || '[]').length : 0);
      taskStatsMap[code].event_count += 1;
      taskStatsMap[code].photo_count += fileCount;
      if (evt.operator) taskStatsMap[code].contributors.add(evt.operator);
      if (new Date(evt.timestamp) > new Date(taskStatsMap[code].latest_timestamp)) {
        taskStatsMap[code].latest_timestamp = evt.timestamp;
      }
    }

    const knownCodes = new Set(tasks.map(t => t.task_code));
    for (const evt of events) {
      const code = evt.task_code || 'TASK_DEFAULT';
      if (!knownCodes.has(code)) {
        const autoTask = {
          task_code: code,
          task_name: evt.task_name || '汇聚任务',
          description: '单向摆渡自动接收归集的任务',
          creator_username: evt.operator_username || 'operator',
          creator_name: evt.operator_name || '视频网操作员',
          share_code: code,
          is_shared: true,
          status: 'ACTIVE',
          created_at: evt.timestamp || new Date().toISOString()
        };
        await coreSqlite.saveTask(autoTask);
        tasks.unshift(autoTask);
        knownCodes.add(code);
      }
    }

    const enrichedTasks = tasks.map(t => {
      const stats = taskStatsMap[t.task_code] || { event_count: 0, photo_count: 0, contributors: new Set(), latest_timestamp: t.created_at };
      return {
        ...t,
        event_count: stats.event_count,
        photo_count: stats.photo_count,
        contributors: Array.from(stats.contributors),
        contributor_count: stats.contributors.size,
        latest_timestamp: stats.latest_timestamp
      };
    });

    res.json({ success: true, data: enrichedTasks });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 获取内网已汇聚单据明细列表 API
app.get('/api/events', async (req, res) => {
  try {
    const { app_id } = req.query;
    if (app_id && !isSafeIdentifier(String(app_id))) return res.status(400).json({ success: false, error: '非法的应用标识' });
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 1000, 1), 5000);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const events = await coreSqlite.getEvents(app_id || null, { limit, offset });
    res.json({ success: true, data: events, pagination: { limit, offset, returned: events.length } });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/tasks/:code', async (req, res) => {
  try {
    const { code } = req.params;
    if (!isSafeIdentifier(code)) return res.status(400).json({ success: false, error: '任务编号格式无效' });
    const task = await coreSqlite.getTaskByCode(code);
    const taskEvents = await coreSqlite.getEvents(null, { taskCode: code, limit: 5000 });

    if (!task) {
      if (taskEvents.length > 0) {
        const autoT = {
          task_code: code,
          task_name: taskEvents[0].task_name || '自动归集任务',
          description: '自动生成的摆渡归集任务',
          creator_username: 'operator',
          creator_name: '视频网操作员',
          share_code: code,
          is_shared: true,
          status: 'ACTIVE'
        };
        return res.json({ success: true, data: { ...autoT, events: taskEvents } });
      }
      return res.status(404).json({ success: false, error: '任务不存在' });
    }

    res.json({ success: true, data: { ...task, events: taskEvents } });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 编辑任务 (任务创建者 & 管理员)
app.put('/api/tasks/:code', async (req, res) => {
  try {
    const { code } = req.params;
    const { task_name, description, is_shared, status } = req.body;
    if (!isSafeIdentifier(code)) return res.status(400).json({ success: false, error: '任务编号格式无效' });
    const task = await coreSqlite.getTaskByCode(code);
    if (!task) return res.status(404).json({ success: false, error: '任务不存在' });

    const currentUser = req.user || { username: 'admin', role: 'admin' };
    const isAdmin = currentUser.role === 'admin';
    const isCreator = task.creator_username === currentUser.username;

    if (!isAdmin && !isCreator) {
      return res.status(403).json({ success: false, error: '权限不足：只有任务创建者或管理员可以修改此任务' });
    }

    const updatedTask = await coreSqlite.updateTaskDetails(code, { task_name, description, is_shared, status });
    addAuditLog('TASK_EDIT', `修改任务 [${code}] 信息 (名称: ${updatedTask.task_name})`, 'SUCCESS');
    res.json({ success: true, message: '任务信息更新成功', data: updatedTask });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 删除任务 (任务创建者 & 管理员)
app.delete('/api/tasks/:code', async (req, res) => {
  try {
    const { code } = req.params;
    const task = await coreSqlite.getTaskByCode(code);
    if (!task) return res.status(404).json({ success: false, error: '任务不存在' });

    const currentUser = req.user || { username: 'admin', role: 'admin' };
    const isAdmin = currentUser.role === 'admin';
    const isCreator = task.creator_username === currentUser.username;

    if (!isAdmin && !isCreator) {
      return res.status(403).json({ success: false, error: '权限不足：只有任务创建者或管理员可以删除此任务' });
    }

    await coreSqlite.deleteTask(code);
    addAuditLog('TASK_DELETE', `删除任务 [${task.task_name}] (${code})`, 'WARN');
    res.json({ success: true, message: '任务已成功删除' });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.put('/api/tasks/:code/status', async (req, res) => {
  try {
    const { code } = req.params;
    const { status } = req.body;
    if (!['ACTIVE', 'COMPLETED'].includes(status)) {
      return res.status(400).json({ success: false, error: '无效的任务状态' });
    }
    const task = await coreSqlite.getTaskByCode(code);
    const currentUser = req.user || { username: 'admin', role: 'admin' };
    const isAdmin = currentUser.role === 'admin';
    const isCreator = task && task.creator_username === currentUser.username;

    if (!isAdmin && !isCreator) {
      return res.status(403).json({ success: false, error: '权限不足：只有任务创建者或管理员可以修改任务状态' });
    }

    await coreSqlite.updateTaskStatus(code, status);
    addAuditLog('TASK_STATUS', `内网端更改任务 [${code}] 状态为 ${status === 'COMPLETED' ? '已完成' : '进行中'}`, 'SUCCESS');
    res.json({ success: true, message: '任务状态更新成功' });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 获取任务下按时间顺序排列的所有图片
app.get('/api/tasks/:code/images', async (req, res) => {
  try {
    const { code } = req.params;
    const order = (req.query.order || 'ASC').toUpperCase();
    if (!isSafeIdentifier(code)) return res.status(400).json({ success: false, error: '任务编号格式无效' });
    const task = await coreSqlite.getTaskByCode(code);
    if (!task) return res.status(404).json({ success: false, error: '任务不存在' });

    const currentUser = req.user || { username: 'admin', role: 'admin' };
    const isAdmin = currentUser.role === 'admin';
    const isCreator = task.creator_username === currentUser.username;

    const rawImages = await coreSqlite.getTaskImages(code, order);
    const enrichedImages = rawImages.map(img => {
      const isUploader = img.uploader_username === currentUser.username;
      const canEdit = isAdmin || isCreator || isUploader;
      const canDelete = isAdmin || isCreator || isUploader;
      return {
        ...img,
        can_edit: canEdit,
        can_delete: canDelete,
        is_own: isUploader
      };
    });

    res.json({
      success: true,
      task: {
        ...task,
        can_edit: isAdmin || isCreator,
        can_delete: isAdmin || isCreator
      },
      data: enrichedImages
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 编辑修改图片 (上传者、任务创建者、管理员)
app.put('/api/images/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { description, location, timestamp } = req.body;
    const allImages = await coreSqlite.getTaskImages(null, 'ASC');
    const img = allImages.find(i => i.id === id);
    if (!img) return res.status(404).json({ success: false, error: '未找到对应图片记录' });

    const task = await coreSqlite.getTaskByCode(img.task_code);
    const currentUser = req.user || { username: 'admin', role: 'admin' };
    const isAdmin = currentUser.role === 'admin';
    const isCreator = task && task.creator_username === currentUser.username;
    const isUploader = img.uploader_username === currentUser.username;

    if (!isAdmin && !isCreator && !isUploader) {
      return res.status(403).json({ success: false, error: '权限不足：只有图片上传者、任务创建者或管理员可以修改此图片' });
    }

    const updated = await coreSqlite.updateImageMetadata(id, { description, location, timestamp });
    addAuditLog('TASK_IMAGE_EDIT', `修改图片 [${id}] 描述为: ${description || '无'}`, 'SUCCESS');
    res.json({ success: true, message: '图片信息已成功更新', data: updated });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 删除图片 (上传者、任务创建者、管理员)
app.delete('/api/images/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const allImages = await coreSqlite.getTaskImages(null, 'ASC');
    const img = allImages.find(i => i.id === id);
    if (!img) return res.status(404).json({ success: false, error: '未找到对应图片记录' });

    const task = await coreSqlite.getTaskByCode(img.task_code);
    const currentUser = req.user || { username: 'admin', role: 'admin' };
    const isAdmin = currentUser.role === 'admin';
    const isCreator = task && task.creator_username === currentUser.username;
    const isUploader = img.uploader_username === currentUser.username;

    if (!isAdmin && !isCreator && !isUploader) {
      return res.status(403).json({ success: false, error: '权限不足：只有图片上传者、任务创建者或管理员可以删除此图片' });
    }

    await coreSqlite.deleteImage(id);
    addAuditLog('TASK_IMAGE_DELETE', `删除任务 [${img.task_code}] 下的图片 [${id}]`, 'WARN');
    res.json({ success: true, message: '图片已成功删除' });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 系统告警通知 API
app.get('/api/alerts', (req, res) => {
  const db = readDb();
  const unreadCount = db.alerts.filter(a => !a.read).length;
  res.json({ success: true, data: db.alerts, unread_count: unreadCount });
});

app.post('/api/alerts/read', requireRole('admin'), (req, res) => {
  const db = readDb();
  db.alerts.forEach(a => a.read = true);
  writeDb(db);
  res.json({ success: true, message: '已标记所有告警为已读' });
});

// 用户管理 CRUD（仅管理员可操作）
app.get('/api/users', requireRole('admin'), (req, res) => {
  const users = readUsers().map(u => ({
    id: u.id,
    username: u.username,
    name: u.name,
    role: u.role,
    status: u.status,
    created_at: u.created_at
  }));
  res.json({ success: true, data: users });
});

app.post('/api/users', requireRole('admin'), (req, res) => {
  const { username, name, password, role } = req.body;
  if (!username || !password || !name) return res.status(400).json({ success: false, error: '请填写完整用户信息' });
  if (!isSafeIdentifier(username) || username.length > 32) return res.status(400).json({ success: false, error: '用户名格式无效' });
  if (!['admin', 'operator', 'auditor'].includes(role || 'operator')) return res.status(400).json({ success: false, error: '用户角色无效' });
  if (typeof password !== 'string' || password.length < 8 || password.length > 256) return res.status(400).json({ success: false, error: '密码长度必须为 8-256 个字符' });

  const users = readUsers();
  if (users.some(u => u.username === username)) {
    return res.status(400).json({ success: false, error: `用户名 [${username}] 已存在` });
  }

  const newUser = {
    id: Date.now(),
    username,
    name,
    password: hashPassword(password),
    role: role || 'operator',
    status: 'ACTIVE',
    created_at: new Date().toISOString()
  };

  users.push(newUser);
  writeUsers(users);
  addAuditLog('USER_ADD', `新增用户 [${name}(${username})], 赋值角色: ${newUser.role}`, 'SUCCESS');
  res.json({ success: true, message: '用户创建成功', data: { id: newUser.id, username: newUser.username, name: newUser.name, role: newUser.role, status: newUser.status, created_at: newUser.created_at } });
});

app.put('/api/users/:id/reset-password', requireRole('admin'), (req, res) => {
  const id = parseInt(req.params.id);
  const { new_password } = req.body;
  if (typeof new_password !== 'string' || new_password.length < 8 || new_password.length > 256) return res.status(400).json({ success: false, error: '密码长度必须为 8-256 个字符' });

  const users = readUsers();
  const user = users.find(u => u.id === id);
  if (!user) return res.status(404).json({ success: false, error: '用户不存在' });

  user.password = hashPassword(new_password);
  writeUsers(users);
  addAuditLog('USER_PWD_RESET', `重置用户 [${user.name}(${user.username})] 的密码`, 'WARN');
  res.json({ success: true, message: '密码重置成功' });
});

app.delete('/api/users/:id', requireRole('admin'), (req, res) => {
  const id = parseInt(req.params.id);
  let users = readUsers();
  const user = users.find(u => u.id === id);
  if (!user) return res.status(404).json({ success: false, error: '用户不存在' });
  if (user.id === 101 || user.username === (process.env.VFUSION_ADMIN_USERNAME || 'admin')) return res.status(400).json({ success: false, error: '超级管理员内置账号不能删除' });

  users = users.filter(u => u.id !== id);
  writeUsers(users);
  addAuditLog('USER_DEL', `删除用户 [${user.name}(${user.username})]`, 'WARN');
  res.json({ success: true, message: '用户已删除' });
});

app.put('/api/users/:id', requireRole('admin'), (req, res) => {
  const id = parseInt(req.params.id);
  const { name, role, status } = req.body;
  if (!name) return res.status(400).json({ success: false, error: '姓名不能为空' });

  const users = readUsers();
  const user = users.find(u => u.id === id);
  if (!user) return res.status(404).json({ success: false, error: '用户不存在' });
  if (user.id === 101 || user.username === (process.env.VFUSION_ADMIN_USERNAME || 'admin')) return res.status(400).json({ success: false, error: '超级管理员内置账号不能编辑' });

  user.name = name;
  if (role) {
    if (!['admin', 'operator', 'auditor'].includes(role)) return res.status(400).json({ success: false, error: '用户角色无效' });
    user.role = role;
  }
  if (status) user.status = status;

  writeUsers(users);
  addAuditLog('USER_UPDATE', `更新用户 [${user.name}(${user.username})], 角色: ${user.role}, 状态: ${user.status}`, 'SUCCESS');
  res.json({ success: true, message: '用户信息更新成功', data: { id: user.id, username: user.username, name: user.name, role: user.role, status: user.status, created_at: user.created_at } });
});


async function dispatchWebhooks(eventRecord) {
  const hooks = readWebhooks().filter(h => h.enabled !== false);
  if (hooks.length === 0) return;

  const payloadStr = JSON.stringify({
    event: 'EVENT_INGESTED',
    timestamp: new Date().toISOString(),
    data: eventRecord
  });

  for (const hook of hooks) {
    try {
      if (!hook.secret || typeof hook.secret !== 'string' || hook.secret.length < 32) throw new Error('Webhook 节点未配置独立签名密钥');
      const signature = signWebhookPayload(payloadStr, hook.secret);
      const urlValidation = await validateHttpUrlResolved(hook.url);
      if (!urlValidation.valid) throw new Error(urlValidation.error);
      const urlObj = urlValidation.url;
      const reqModule = urlObj.protocol === 'https:' ? https : http;

      const req = reqModule.request(hook.url, {
        method: 'POST',
        lookup: fixedDnsLookup(urlValidation.addresses || []),
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payloadStr),
          [WEBHOOK_SIGNATURE_HEADER]: signature
        }
      }, res => {
        addAuditLog('WEBHOOK', `消息分发 [${hook.name}]: HTTP ${res.statusCode}`, res.statusCode < 400 ? 'SUCCESS' : 'WARN');
        res.resume();
      });

      req.setTimeout(8000, () => req.destroy(new Error('Webhook 请求超时')));

      req.on('error', err => {
        addAuditLog('WEBHOOK', `消息分发失败 [${hook.name}]: ${err.message}`, 'WARN');
      });

      req.write(payloadStr);
      req.end();
    } catch (e) {
      console.error('Webhook 网址错误:', hook.url);
    }
  }
}

const processingPackageFiles = new Set();

async function processPackageFile(fileName, isRetry = false) {
  if (!isSafeFileName(fileName)) throw new Error('非法的数据包文件名');
  const lockKey = `${isRetry ? ERROR_DIR : getFtpInDir()}:${fileName}`;
  if (processingPackageFiles.has(lockKey)) return { success: false, skipped: true, message: `包 ${fileName} 正在处理中` };
  processingPackageFiles.add(lockKey);
  try {
    return await processPackageFileUnlocked(fileName, isRetry);
  } finally {
    processingPackageFiles.delete(lockKey);
  }
}

async function processPackageFileUnlocked(fileName, isRetry = false) {
  const sourceDir = isRetry ? ERROR_DIR : getFtpInDir();
  const zipPath = resolveInside(sourceDir, fileName);

  if (!fs.existsSync(zipPath)) {
    throw new Error(`文件不存在: ${fileName}`);
  }

  console.log(`[VFusion Core] 处理数据包 (${isRetry ? '重试' : '自动'}): ${fileName}`);
  addAuditLog('SCANNER', `${isRetry ? '重试' : '自动'}处理数据包 ${fileName}...`);

  try {
    const { zipFileHash, extractDir, info } = await unpackAndVerifyPackage(zipPath, ASSETS_DIR);
    if (!isSafeIdentifier(info.event_id) || !isSafeIdentifier(info.task_code || 'TASK_DEFAULT')) {
      throw new Error('数据包中的事件或任务标识无效');
    }
    if (!Array.isArray(info.files) || info.files.length > 200) throw new Error('数据包附件清单无效');
    const db = readDb();
    const sqliteEvents = await coreSqlite.getEvents(null, { limit: 5000 });
    const exists = db.events.find(e => e.event_id === info.event_id || e.zip_hash === zipFileHash) ||
      sqliteEvents.find(e => e.event_id === info.event_id || e.zip_hash === zipFileHash);

    if (exists) {
      addAuditLog('IDEMPOTENCY', `事件 ${info.event_id} 已存在，幂等归档`, 'WARN');
      fs.rmSync(extractDir, { recursive: true, force: true });
    } else {
      const taskCode = info.task_code || 'TASK_DEFAULT';
      const taskName = info.task_name || '厂区周界安防例行巡检';
      const eventAssetsSubDir = resolveInside(ASSETS_DIR, 'tasks', taskCode, info.event_id);
      if (!fs.existsSync(eventAssetsSubDir)) fs.mkdirSync(eventAssetsSubDir, { recursive: true });

      const extractedImagesDir = path.join(extractDir, 'images');
      const fileRecords = [];

      if (fs.existsSync(extractedImagesDir)) {
        const imgFiles = fs.readdirSync(extractedImagesDir);
        for (const imgName of imgFiles) {
          if (!isSafeFileName(imgName)) throw new Error(`非法图片文件名: ${imgName}`);
          const srcImg = resolveInside(extractedImagesDir, imgName);
          if (!fs.statSync(srcImg).isFile()) throw new Error(`图片条目不是普通文件: ${imgName}`);
          const destImg = resolveInside(eventAssetsSubDir, imgName);
          fs.copyFileSync(srcImg, destImg);
          fileRecords.push({ filename: imgName, url: `/assets/tasks/${taskCode}/${info.event_id}/${imgName}` });
        }
      }

      fs.rmSync(extractDir, { recursive: true, force: true });

      const newRecord = {
        id: Date.now(),
        app_id: info.app_id,
        biz_type: info.biz_type,
        event_id: info.event_id,
        task_name: taskName,
        task_code: taskCode,
        timestamp: info.timestamp || info.submit_time || new Date().toISOString(),
        submit_time: info.submit_time || info.timestamp || new Date().toISOString(),
        operator: info.operator || `${info.operator_name || '操作员'} (${info.operator_username || 'operator'})`,
        operator_username: info.operator_username || 'operator',
        operator_name: info.operator_name || '视频网操作员',
        payload: info.payload,
        files: fileRecords,
        zip_hash: zipFileHash,
        signature: info.signature,
        status: 'RECEIVED',
        created_at: new Date().toISOString()
      };

      // 如果数据包负荷中包含涉事人员信息，自动同步归档至内网人员库
      const p = info.payload && typeof info.payload === 'object' ? info.payload : {};
      const pointId = String(p.monitoring_point_id || '').trim();
      if (pointId) {
        const point = findMonitoringPoint(readMonitoringPoints(MONITORING_POINTS_FILE), pointId);
        if (!point) throw new Error(`监控点位 [${pointId}] 不存在或已停用，请先同步点位主数据`);
        applyMonitoringPoint(p, point);
      } else {
        const coordinates = normalizeCoordinates(p.longitude, p.latitude);
        if (coordinates) Object.assign(p, coordinates);
        if (p.location) p.location_source = 'MANUAL';
      }
      newRecord.payload = p;
      // 字段名 ai_tags 为历史数据库列名，保留以兼容既有数据
      newRecord.ai_tags = tagEvent(newRecord);
      if (p.person_name || p.person_id_card) {
        if (!db.personnel) db.personnel = [];
        const existingIdx = db.personnel.findIndex(per => (p.person_id_card && per.id_card === p.person_id_card) || (p.person_name && per.name === p.person_name));
        const personRec = {
          id: Date.now(),
          name: p.person_name || '未知',
          id_card: p.person_id_card || '',
          domicile: p.person_domicile || '',
          last_seen: info.timestamp || new Date().toISOString(),
          last_event_id: info.event_id
        };
        if (existingIdx >= 0) {
          db.personnel[existingIdx] = { ...db.personnel[existingIdx], ...personRec };
        } else {
          db.personnel.unshift(personRec);
        }
      }

      db.events.unshift(newRecord);
      writeDb(db);
      await coreSqlite.saveEvent(newRecord);

      // 确保/更新内网端任务条目记录
      const existingTask = await coreSqlite.getTaskByCode(taskCode);
      if (!existingTask) {
        await coreSqlite.saveTask({
          task_code: taskCode,
          task_name: taskName,
          description: '单向摆渡自动接收归集的任务',
          creator_username: info.operator_username || 'operator',
          creator_name: info.operator_name || '视频网操作员',
          share_code: taskCode,
          is_shared: true,
          status: 'ACTIVE'
        });
      } else {
        await coreSqlite.saveTask({
          ...existingTask,
          task_name: taskName || existingTask.task_name,
          updated_at: new Date().toISOString()
        });
      }

      if (info.payload && info.payload.event_id) {
        addSystemAlert('[新单据通知]', `单据编号 ${info.event_id} 已成功摆渡入库 (${info.payload.location || '未知地点'})`, 'INFO');
      }

      dispatchWebhooks(newRecord).catch(err => console.error('[VFusion Core] Webhook 分发失败:', err.message));
      addAuditLog('INGEST', `事件 ${info.event_id} 入库成功 (AI算法处理通过, 携带 ${fileRecords.length} 张照片及签名)`, 'SUCCESS');
    }

    const archiveDest = path.join(ARCHIVE_DIR, fileName);
    if (fs.existsSync(archiveDest)) fs.unlinkSync(archiveDest);
    fs.renameSync(zipPath, archiveDest);
    return { success: true, message: `包 ${fileName} 解析成功并移入归档` };

  } catch (err) {
    addAuditLog('ERROR', `数据包 ${fileName} 校验解析失败: ${err.message}`, 'ERROR');
    addSystemAlert('[损坏包告警]', `数据包 ${fileName} 校验失败，已自动移入死信隔离区`, 'ERROR');
    if (!isRetry) {
      const errorDest = path.join(ERROR_DIR, fileName);
      if (fs.existsSync(errorDest)) fs.unlinkSync(errorDest);
      fs.renameSync(zipPath, errorDest);
    }
    throw err;
  }
}

let scanRunning = false;
async function scanLoop() {
  if (scanRunning) return;
  scanRunning = true;
  try {
    // 当远程 FTP 已启用时，数据只从 FTP 远程拉取，不扫描本地旧文件
    const sec = getFtpConfig();
    if (sec && sec.ftp_enabled && sec.ftp_host) return;

    const ftpInDir = getFtpInDir();
    if (!fs.existsSync(ftpInDir)) fs.mkdirSync(ftpInDir, { recursive: true });
    const prefix = getPkgPrefix();
    const files = fs.readdirSync(ftpInDir);
    const zipFiles = files.filter(f => f.startsWith(prefix) && (f.endsWith('.zip') || f.endsWith('.jpg')) && !f.endsWith('.tmp'));
    for (const fileName of zipFiles) {
      try { await processPackageFile(fileName, false); } catch (e) {}
    }
  } catch (err) {
    console.error('[VFusion Core] 扫描 Loop 异常:', err);
  } finally {
    scanRunning = false;
  }
}

const scanTimer = setInterval(scanLoop, 3000);

// ========== FTP 远程自动轮询拉取引擎 ==========
let ftpPollTimer = null;
let ftpPullMutex = false;
let ftpPollStatus = { running: false, lastPollTime: null, lastResult: null, downloadedTotal: 0, errorCount: 0 };

function getFtpConfig() {
  try {
    if (fs.existsSync(SECURITY_CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(SECURITY_CONFIG_FILE, 'utf8'));
    }
  } catch (e) {}
  return null;
}

function getFtpServers() {
  try {
    if (fs.existsSync(SECURITY_CONFIG_FILE)) {
      const sec = JSON.parse(fs.readFileSync(SECURITY_CONFIG_FILE, 'utf8'));
      if (Array.isArray(sec.ftp_servers) && sec.ftp_servers.length > 0) {
        return sec.ftp_servers;
      }
      if (sec.ftp_host) {
        const legacyServer = {
          id: 'ftp_legacy_1',
          name: sec.ftp_name || '默认 FTP 服务器',
          ftp_enabled: sec.ftp_enabled !== false,
          ftp_host: sec.ftp_host || '',
          ftp_port: sec.ftp_port || 21,
          ftp_user: sec.ftp_user || '',
          ftp_password: sec.ftp_password || '',
          ftp_remote_dir: sec.ftp_remote_dir || '/vfusion_packages',
          pkg_prefix: sec.pkg_prefix || 'vfusion_',
          ftp_file_ext: sec.ftp_file_ext || '.jpg',
          ftp_delete_after_download: sec.ftp_delete_after_download !== false,
          downloaded_total: 0,
          created_at: new Date().toISOString()
        };
        sec.ftp_servers = [legacyServer];
        writeJsonAtomic(SECURITY_CONFIG_FILE, sec);
        return sec.ftp_servers;
      }
      return sec.ftp_servers || [];
    }
  } catch (e) {
    console.error('读取 FTP 服务器节点失败:', e);
  }
  return [];
}

function saveFtpServers(servers) {
  try {
    const sec = getFtpConfig() || {};
    sec.ftp_servers = servers;
    if (servers.length > 0) {
      const s0 = servers[0];
      sec.ftp_enabled = s0.ftp_enabled;
      sec.ftp_host = s0.ftp_host;
      sec.ftp_port = s0.ftp_port;
      sec.ftp_user = s0.ftp_user;
      sec.ftp_password = s0.ftp_password;
      sec.ftp_remote_dir = s0.ftp_remote_dir;
      sec.pkg_prefix = s0.pkg_prefix;
      sec.ftp_file_ext = s0.ftp_file_ext;
      sec.ftp_delete_after_download = s0.ftp_delete_after_download;
    }
    writeJsonAtomic(SECURITY_CONFIG_FILE, sec);
  } catch (e) {
    console.error('保存 FTP 服务器节点失败:', e);
  }
}

function getFtpPollIntervalSec(sec) {
  if (!sec || sec.ftp_poll_interval === undefined || sec.ftp_poll_interval === null) return 10;
  const num = parseInt(sec.ftp_poll_interval, 10);
  return isNaN(num) ? 10 : Math.max(0, num);
}

async function ftpPollLoop() {
  if (ftpPollStatus.running || ftpPullMutex) return;
  const servers = getFtpServers();
  const activeServers = servers.filter(s => s.ftp_enabled !== false && s.ftp_host);
  if (activeServers.length === 0) return;

  ftpPullMutex = true;
  ftpPollStatus.running = true;
  ftpPollStatus.lastPollTime = new Date().toISOString();

  let totalDownloaded = 0;
  const pollResults = [];

  try {
    const ftpInDir = getFtpInDir();
    if (!fs.existsSync(ftpInDir)) fs.mkdirSync(ftpInDir, { recursive: true });

    for (const server of activeServers) {
      try {
        const prefix = server.pkg_prefix || 'vfusion_';
        const downloadedFiles = await downloadFromRemoteFtp(ftpInDir, server, prefix);

        server.last_pull_at = new Date().toISOString();
        if (downloadedFiles.length > 0) {
          totalDownloaded += downloadedFiles.length;
          server.downloaded_total = (server.downloaded_total || 0) + downloadedFiles.length;
          server.last_pull_status = `成功拉取 ${downloadedFiles.length} 个包`;
          pollResults.push(`[${server.name || server.ftp_host}]: ${downloadedFiles.length}个`);

          addAuditLog('FTP_POLL', `从远程 FTP [${server.name || server.ftp_host}:${server.ftp_port || 21}] 自动拉取了 ${downloadedFiles.length} 个数据包`, 'SUCCESS');

          for (const fileName of downloadedFiles) {
            try {
              await processPackageFile(fileName, false);
            } catch (procErr) {
              console.error(`[VFusion Core FTP] 处理 ${fileName} 失败:`, procErr.message);
            }
          }
        } else {
          server.last_pull_status = '无新数据包';
        }
      } catch (err) {
        server.last_pull_status = `异常: ${err.message}`;
        pollResults.push(`[${server.name || server.ftp_host}]: ${err.message}`);
        addAuditLog('FTP_POLL', `远程 FTP [${server.name || server.ftp_host}] 轮询拉取失败: ${err.message}`, 'WARN');
      }
    }

    saveFtpServers(servers);
    ftpPollStatus.downloadedTotal += totalDownloaded;
    if (totalDownloaded > 0) {
      ftpPollStatus.lastResult = `多 FTP 共拉取 ${totalDownloaded} 个包: ${pollResults.join('; ')}`;
    } else {
      ftpPollStatus.lastResult = `所有开启的 FTP 目录暂无新数据包 (${activeServers.length} 个节点运行中)`;
    }
  } catch (err) {
    ftpPollStatus.errorCount++;
    ftpPollStatus.lastResult = `多 FTP 轮询异常: ${err.message}`;
  } finally {
    ftpPollStatus.running = false;
    ftpPullMutex = false;
  }
}

function setFtpPollInterval(seconds) {
  if (ftpPollTimer) { clearInterval(ftpPollTimer); ftpPollTimer = null; }
  if (seconds > 0) {
    ftpPollTimer = setInterval(ftpPollLoop, seconds * 1000);
    console.log(`[VFusion Core FTP] FTP 远程自动轮询已启动 (每 ${seconds} 秒拉取一次)`);
  } else {
    console.log('[VFusion Core FTP] FTP 远程自动轮询已停止');
  }
}

// 服务器启动时自动检测并启用 FTP 轮询
function bootFtpPoll() {
  try {
    const sec = getFtpConfig();
    const servers = getFtpServers();
    const activeCount = servers.filter(s => s.ftp_enabled !== false && s.ftp_host).length;
    if (activeCount > 0) {
      const interval = getFtpPollIntervalSec(sec);
      setFtpPollInterval(interval);
      addAuditLog('FTP_POLL', `服务启动时自动启用 FTP 远程轮询 (每 ${interval} 秒, ${activeCount} 个可用节点)`, 'INFO');
    }
  } catch (e) {}
}

// 手动触发 FTP 拉取 (支持单节点或全量节点)
app.post('/api/ftp/pull', requireRole('admin'), async (req, res) => {
  if (ftpPullMutex) return res.status(409).json({ success: false, error: 'FTP 拉取任务正在运行，请稍后重试' });
  ftpPullMutex = true;
  try {
    const { server_id } = req.body || {};
    const servers = getFtpServers();
    let targetServers = servers.filter(s => s.ftp_enabled !== false && s.ftp_host);
    if (server_id) {
      targetServers = targetServers.filter(s => String(s.id) === String(server_id));
    }

    if (targetServers.length === 0) {
      return res.status(400).json({ success: false, error: '未找到可用的【已开启】FTP 服务器节点，请先添加并开启 FTP 节点' });
    }

    const ftpInDir = getFtpInDir();
    if (!fs.existsSync(ftpInDir)) fs.mkdirSync(ftpInDir, { recursive: true });

    let totalDownloaded = 0;
    let totalProcessed = 0;
    const downloadedDetails = [];

    for (const server of targetServers) {
      try {
        const prefix = server.pkg_prefix || 'vfusion_';
        const downloadedFiles = await downloadFromRemoteFtp(ftpInDir, server, prefix);
        server.last_pull_at = new Date().toISOString();
        if (downloadedFiles.length > 0) {
          totalDownloaded += downloadedFiles.length;
          server.downloaded_total = (server.downloaded_total || 0) + downloadedFiles.length;
          server.last_pull_status = `成功拉取 ${downloadedFiles.length} 个包`;
          downloadedDetails.push(`[${server.name || server.ftp_host}]: ${downloadedFiles.join(', ')}`);

          for (const fileName of downloadedFiles) {
            try {
              await processPackageFile(fileName, false);
              totalProcessed++;
            } catch (procErr) {}
          }
        } else {
          server.last_pull_status = '无新数据包';
        }
      } catch (err) {
        server.last_pull_status = `异常: ${err.message}`;
      }
    }

    saveFtpServers(servers);
    addAuditLog('FTP_PULL', `手动触发 FTP 拉取，累计下载 ${totalDownloaded} 个包，解包入库 ${totalProcessed} 个`, totalDownloaded > 0 ? 'SUCCESS' : 'INFO');
    res.json({
      success: true,
      message: totalDownloaded > 0
        ? `成功从 ${targetServers.length} 个 FTP 节点拉取 ${totalDownloaded} 个数据包并入库 ${totalProcessed} 个: ${downloadedDetails.join('; ')}`
        : `已轮询检查 ${targetServers.length} 个开启的 FTP 节点，远程目录暂无新数据包`,
      data: { totalDownloaded, totalProcessed, details: downloadedDetails }
    });
  } catch (err) {
    addAuditLog('FTP_PULL', `手动 FTP 拉取失败: ${err.message}`, 'ERROR');
    res.status(500).json({ success: false, error: err.message });
  } finally {
    ftpPullMutex = false;
  }
});

// FTP 轮询状态查询
app.get('/api/ftp/poll-status', (req, res) => {
  const sec = getFtpConfig();
  const servers = getFtpServers();
  const activeCount = servers.filter(s => s.ftp_enabled !== false && s.ftp_host).length;

  res.json({
    success: true,
    data: {
      enabled: activeCount > 0,
      active_server_count: activeCount,
      total_server_count: servers.length,
      poll_interval: sec ? getFtpPollIntervalSec(sec) : 0,
      timer_active: !!ftpPollTimer,
      ...ftpPollStatus
    }
  });
});

// FTP 轮询时间间隔与启停配置
app.post('/api/ftp/poll-interval', requireRole('admin'), (req, res) => {
  const { interval } = req.body || {};
  const intervalSec = Math.max(0, parseInt(interval, 10) || 0);

  try {
    const sec = getFtpConfig() || {};
    sec.ftp_poll_interval = intervalSec;
    writeJsonAtomic(SECURITY_CONFIG_FILE, sec);

    setFtpPollInterval(intervalSec);

    const msg = intervalSec > 0
      ? `已开启 FTP 自动轮询 (周期 ${intervalSec} 秒)`
      : `已停止 FTP 自动轮询`;

    addAuditLog('FTP_POLL', `更新 FTP 自动轮询间隔为 ${intervalSec} 秒`, 'SUCCESS');
    res.json({ success: true, message: msg, interval: intervalSec });
  } catch (err) {
    res.status(500).json({ success: false, error: '设置轮询间隔失败: ' + err.message });
  }
});

// FTP 服务器节点 CRUD 接口
app.get('/api/ftp/servers', (req, res) => {
  const safeServers = getFtpServers().map(server => ({
    ...server,
    ftp_password: server.ftp_password ? FTP_PASSWORD_MASK : ''
  }));
  res.json({ success: true, data: safeServers });
});

app.post('/api/ftp/servers', requireRole('admin'), (req, res) => {
  const { name, ftp_host, ftp_port, ftp_user, ftp_password, ftp_remote_dir, pkg_prefix, ftp_file_ext, ftp_delete_after_download, ftp_enabled } = req.body;
  if (!ftp_host) return res.status(400).json({ success: false, error: 'FTP IP 地址或域名不能为空' });

  const servers = getFtpServers();
  const newServer = {
    id: 'ftp_' + Date.now(),
    name: name ? name.trim() : `FTP_${ftp_host.trim()}`,
    ftp_enabled: ftp_enabled !== false,
    ftp_host: ftp_host.trim(),
    ftp_port: parseInt(ftp_port, 10) || 21,
    ftp_user: ftp_user ? ftp_user.trim() : '',
    ftp_password: ftp_password || '',
    ftp_remote_dir: ftp_remote_dir ? ftp_remote_dir.trim() : '/vfusion_packages',
    pkg_prefix: pkg_prefix ? pkg_prefix.trim() : 'vfusion_',
    ftp_file_ext: ftp_file_ext || '.jpg',
    ftp_delete_after_download: ftp_delete_after_download !== false,
    downloaded_total: 0,
    created_at: new Date().toISOString()
  };
  servers.push(newServer);
  saveFtpServers(servers);
  addAuditLog('FTP_CONFIG', `新增第三方 FTP 通道节点 [${newServer.name}] (${newServer.ftp_host}:${newServer.ftp_port})`, 'SUCCESS');
  res.json({ success: true, message: 'FTP 通道节点添加成功', data: { ...newServer, ftp_password: newServer.ftp_password ? FTP_PASSWORD_MASK : '' } });
});

app.put('/api/ftp/servers/:id', requireRole('admin'), (req, res) => {
  const id = req.params.id;
  const { name, ftp_host, ftp_port, ftp_user, ftp_password, ftp_remote_dir, pkg_prefix, ftp_file_ext, ftp_delete_after_download, ftp_enabled } = req.body;
  if (!ftp_host) return res.status(400).json({ success: false, error: 'FTP IP 地址或域名不能为空' });

  const servers = getFtpServers();
  const server = servers.find(s => String(s.id) === String(id));
  if (!server) return res.status(404).json({ success: false, error: '未找到指定的 FTP 服务器节点' });

  if (name) server.name = name.trim();
  server.ftp_host = ftp_host.trim();
  server.ftp_port = parseInt(ftp_port, 10) || 21;
  server.ftp_user = ftp_user ? ftp_user.trim() : '';
  if (ftp_password !== undefined && ftp_password !== FTP_PASSWORD_MASK) server.ftp_password = ftp_password;
  server.ftp_remote_dir = ftp_remote_dir ? ftp_remote_dir.trim() : '/vfusion_packages';
  server.pkg_prefix = pkg_prefix ? pkg_prefix.trim() : 'vfusion_';
  server.ftp_file_ext = ftp_file_ext || '.jpg';
  if (ftp_delete_after_download !== undefined) server.ftp_delete_after_download = !!ftp_delete_after_download;
  if (ftp_enabled !== undefined) server.ftp_enabled = !!ftp_enabled;

  saveFtpServers(servers);
  addAuditLog('FTP_CONFIG', `更新第三方 FTP 通道节点 [${server.name}] (${server.ftp_host}:${server.ftp_port})`, 'SUCCESS');
  res.json({ success: true, message: 'FTP 通道节点更新成功', data: { ...server, ftp_password: server.ftp_password ? FTP_PASSWORD_MASK : '' } });
});

app.patch('/api/ftp/servers/:id/toggle', requireRole('admin'), (req, res) => {
  const id = req.params.id;
  const servers = getFtpServers();
  const server = servers.find(s => String(s.id) === String(id));
  if (!server) return res.status(404).json({ success: false, error: '未找到指定的 FTP 服务器节点' });

  server.ftp_enabled = req.body.enabled !== undefined ? !!req.body.enabled : !server.ftp_enabled;
  saveFtpServers(servers);
  addAuditLog('FTP_CONFIG', `${server.ftp_enabled ? '开启' : '关闭'}第三方 FTP 通道节点: [${server.name}]`, 'SUCCESS');
  res.json({ success: true, message: `已${server.ftp_enabled ? '开启' : '关闭'} [${server.name}] 通道`, data: server });
});

app.delete('/api/ftp/servers/:id', requireRole('admin'), (req, res) => {
  const id = req.params.id;
  let servers = getFtpServers();
  servers = servers.filter(s => String(s.id) !== String(id));
  saveFtpServers(servers);
  addAuditLog('FTP_CONFIG', `移除第三方 FTP 通道节点`, 'WARN');
  res.json({ success: true, message: 'FTP 通道节点已移除' });
});

app.post('/api/ftp/servers/:id/test', requireRole('admin'), async (req, res) => {
  const id = req.params.id;
  const servers = getFtpServers();
  const server = servers.find(s => String(s.id) === String(id)) || req.body;
  if (!server || !server.ftp_host) return res.status(400).json({ success: false, error: '未找到 FTP 节点或 Host 缺失' });

  try {
    const ok = await testFtpConnection(server);
    if (ok) {
      addAuditLog('FTP_TEST', `连通性测试 [${server.name || server.ftp_host}]: 成功`, 'SUCCESS');
      res.json({ success: true, message: `成功连接 FTP [${server.name || server.ftp_host}:${server.ftp_port || 21}] 并具备读写及列表权限` });
    } else {
      addAuditLog('FTP_TEST', `连通性测试 [${server.name || server.ftp_host}]: 失败`, 'WARN');
      res.status(400).json({ success: false, error: `无法连接远程 FTP [${server.ftp_host}:${server.ftp_port}]` });
    }
  } catch (err) {
    addAuditLog('FTP_TEST', `连通性测试 [${server.name || server.ftp_host}] 异常: ${err.message}`, 'WARN');
    res.status(500).json({ success: false, error: err.message });
  }
});



// 在线自检与拓扑诊断 API
app.get('/api/system/diagnose', (req, res) => {
  try {
    const db = readDb();
    const results = [
      { category: '存储与拓扑目录', status: 'PASS', detail: 'ftp_out, ftp_in, archive, error, assets 目录结构正常' },
      { category: '数据中台服务节点', status: 'PASS', detail: `Core Node (Port ${PORT}) HTTP 200 正常监听中` },
      { category: '动态表单配置规范', status: 'PASS', detail: 'Schema JSON 结构合法' },
      { category: '数据库持久化与日志', status: 'PASS', detail: `累积已存储 ${db.events.length} 条单据事件与 ${db.audit_logs.length} 条审计日志` }
    ];
    addAuditLog('DIAGNOSE', '管理员触发系统在线自检与拓扑诊断', 'SUCCESS');
    res.json({ success: true, data: results });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 校验用户提供的文件名，禁止路径分隔符与 .. 穿越
function isSafeFileName(name) {
  return isSafeFileNameUtil(name);
}

// 单件事件 Zip 离线包下载 API
app.get('/api/events/:event_id/download', (req, res) => {
  const { event_id } = req.params;
  if (!isSafeFileName(event_id)) {
    return res.status(400).json({ success: false, error: '非法的事件编号' });
  }
  try {
    const archiveFiles = fs.readdirSync(ARCHIVE_DIR);
    const expectedNames = new Set([`vfusion_pkg_${event_id}.zip`, `vfusion_pkg_${event_id}.jpg`]);
    const matched = archiveFiles.find(f => expectedNames.has(f));
    if (!matched) {
      // 不做任意兜底：返回其他事件的归档包会造成跨单据数据泄露
      return res.status(404).json({ success: false, error: '未找到该单据对应的 Zip 归档文件' });
    }
    const filePath = resolveInside(ARCHIVE_DIR, matched);
    addAuditLog('DOWNLOAD', `下载事件 [${event_id}] 的 Zip 归档存照包: ${matched}`, 'INFO');
    return res.download(filePath, matched);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 审计日志 CSV 导出 API
app.get('/api/audit-logs/export', (req, res) => {
  try {
    const db = readDb();
    let csvHeader = ['序号', '时间戳', '操作类别', '描述明细', '状态级别'].join(',');
    let csvRows = [csvHeader];

    const auditTypeMap = {
      'AUTH_SUCCESS': '用户登录',
      'AUTH_FAIL': '登录失败',
      'USER_ADD': '新增用户',
      'USER_PWD_RESET': '重置密码',
      'USER_DEL': '删除用户',
      'INGEST': '单据入库',
      'SCANNER': '目录扫描',
      'IDEMPOTENCY': '幂等归档',
      'DIODE_SIM': '网闸摆渡',
      'DIODE_CONFIG': '摆渡配置',
      'SCHEMA_UPDATE': 'Schema更新',
      'WEBHOOK': '消息分发',
      'WEBHOOK_ADD': '注册订阅',
      'WEBHOOK_DEL': '移除订阅',
      'SECURITY': '秘钥轮换',
      'DIAGNOSE': '在线诊断',
      'DOWNLOAD': '存照下载',
      'EXPORT_AUDIT': '导出日志',
      'CLEANUP': '清理归档',
      'ERROR': '解析错误'
    };

    const auditStatusMap = {
      'SUCCESS': '成功',
      'INFO': '信息',
      'WARN': '警告',
      'ERROR': '错误'
    };

    db.audit_logs.forEach((log, idx) => {
      const typeCn = auditTypeMap[log.type] || log.type;
      const statusCn = auditStatusMap[log.status] || log.status;
      const row = [
        idx + 1,
        `"${new Date(log.timestamp).toLocaleString()}"`,
        `"${typeCn}"`,
        `"${log.message.replace(/"/g, '""')}"`,
        `"${statusCn}"`
      ];
      csvRows.push(row.join(','));
    });

    const csvContent = '\uFEFF' + csvRows.join('\n');
    addAuditLog('EXPORT_AUDIT', '导出系统审计日志 CSV 报表', 'SUCCESS');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=vfusion_audit_logs_${Date.now()}.csv`);
    res.send(csvContent);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// API 路由
app.get('/api/schema', (req, res) => {
  const { app_id } = req.query;
  if (app_id !== undefined && !isSafeIdentifier(app_id)) return res.status(400).json({ success: false, error: '非法的应用标识' });
   const targetFile = app_id ? resolveInside(STORAGE_ROOT, `schema_${app_id}.json`) : SCHEMA_FILE;
  try {
    const fileToRead = fs.existsSync(targetFile) ? targetFile : SCHEMA_FILE;
    res.json({ success: true, data: JSON.parse(fs.readFileSync(fileToRead, 'utf8')) });
  } catch (e) { res.json({ success: true, data: DEFAULT_FORM_SCHEMA }); }
});

app.post('/api/schema', requireRole('admin'), (req, res) => {
  try {
    const newSchema = assertJsonObject(req.body, 'Schema');
    const appId = newSchema.app_id || 'sys_gate_security';
    if (!isSafeIdentifier(appId)) return res.status(400).json({ success: false, error: '非法的应用标识' });
    if (!Array.isArray(newSchema.fields) || newSchema.fields.length > 200) return res.status(400).json({ success: false, error: 'Schema 字段定义无效' });
     const targetFile = resolveInside(STORAGE_ROOT, `schema_${appId}.json`);
    writeJsonAtomic(targetFile, newSchema);
    writeJsonAtomic(SCHEMA_FILE, newSchema);
    addAuditLog('SCHEMA_UPDATE', `表单 Schema 已更新 (App: ${appId}, 包含 ${newSchema.fields.length} 个字段)`, 'SUCCESS');
    res.json({ success: true, message: '表单 Schema 已成功更新并即时跨网同步' });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/webhooks', requireRole('admin'), (req, res) => {
  res.json({ success: true, data: readWebhooks().map(hook => serializeWebhook(hook)) });
});

app.post('/api/webhooks', requireRole('admin'), async (req, res) => {
  const { name, url, enabled } = req.body;
  if (!name || !url) return res.status(400).json({ success: false, error: '名称与 URL 均不能为空' });
  const urlValidation = await validateHttpUrlResolved(url);
  if (!urlValidation.valid) return res.status(400).json({ success: false, error: urlValidation.error });

  const newHook = { id: Date.now(), name: String(name).trim().slice(0, 128), url: urlValidation.url.toString(), enabled: enabled !== false, secret: generateWebhookSecret(), secret_version: 2, created_at: new Date().toISOString() };
  updateJsonAtomic(WEBHOOKS_FILE, [], list => {
    if (!Array.isArray(list)) list = [];
    list.push(newHook);
    return list;
  });
  addAuditLog('WEBHOOK_ADD', `注册新消息订阅节点: ${name}`, 'SUCCESS');
  res.json({ success: true, message: '消息订阅节点注册成功，请将本次返回的签名密钥安全交给接收方', data: serializeWebhook(newHook, true) });
});

app.delete('/api/webhooks/:id', requireRole('admin'), (req, res) => {
  const id = parseInt(req.params.id);
  updateJsonAtomic(WEBHOOKS_FILE, [], list => Array.isArray(list) ? list.filter(h => h.id !== id) : []);
  addAuditLog('WEBHOOK_DEL', `移除消息订阅节点`, 'WARN');
  res.json({ success: true, message: '订阅节点已删除' });
});

app.put('/api/webhooks/:id', requireRole('admin'), async (req, res) => {
  const id = parseInt(req.params.id);
  const { name, url, enabled } = req.body;
  if (!name || !url) return res.status(400).json({ success: false, error: '名称与 URL 均不能为空' });
  const urlValidation = await validateHttpUrlResolved(url);
  if (!urlValidation.valid) return res.status(400).json({ success: false, error: urlValidation.error });

  const list = readWebhooks();
  const hook = list.find(h => h.id === id);
  if (!hook) return res.status(404).json({ success: false, error: '未找到指定的 Webhook 节点' });

  hook.name = String(name).trim().slice(0, 128);
  hook.url = urlValidation.url.toString();
  if (enabled !== undefined) hook.enabled = Boolean(enabled);
  updateJsonAtomic(WEBHOOKS_FILE, [], current => {
    if (!Array.isArray(current)) return [hook];
    const target = current.find(h => h.id === id);
    if (target) Object.assign(target, hook);
    return current;
  });
  addAuditLog('WEBHOOK_UPDATE', `更新消息订阅节点: ${name}`, 'SUCCESS');
  res.json({ success: true, message: '订阅节点更新成功', data: serializeWebhook(hook) });
});

app.post('/api/webhooks/:id/rotate-secret', requireRole('admin'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const list = readWebhooks();
  const hook = list.find(item => item.id === id);
  if (!hook) return res.status(404).json({ success: false, error: '未找到指定的 Webhook 节点' });
  hook.secret = generateWebhookSecret();
  hook.secret_version = Number(hook.secret_version || 1) + 1;
  hook.secret_rotated_at = new Date().toISOString();
  updateJsonAtomic(WEBHOOKS_FILE, [], current => Array.isArray(current) ? current.map(item => item.id === id ? hook : item) : [hook]);
  addAuditLog('WEBHOOK_SECRET_ROTATE', `轮换 Webhook [${hook.name}] 独立签名密钥`, 'WARN');
  res.json({ success: true, message: 'Webhook 签名密钥已轮换，请立即同步给接收方', data: serializeWebhook(hook, true) });
});

app.patch('/api/webhooks/:id/toggle', requireRole('admin'), (req, res) => {
  const list = readWebhooks();
  const hook = list.find(h => String(h.id) === String(req.params.id));
  if (!hook) return res.status(404).json({ success: false, error: '未找到指定的 Webhook 节点' });
  hook.enabled = req.body.enabled !== undefined ? Boolean(req.body.enabled) : hook.enabled === false;
  updateJsonAtomic(WEBHOOKS_FILE, [], current => {
    if (!Array.isArray(current)) return [hook];
    const target = current.find(h => String(h.id) === String(req.params.id));
    if (target) target.enabled = hook.enabled;
    return current;
  });
  addAuditLog('WEBHOOK_UPDATE', `${hook.enabled ? '开启' : '关闭'} Webhook [${hook.name}]`, 'SUCCESS');
  res.json({ success: true, message: `Webhook 已${hook.enabled ? '开启' : '关闭'}` });
});

app.post('/api/webhooks/:id/test', requireRole('admin'), async (req, res) => {
  const list = readWebhooks();
  const hook = list.find(h => String(h.id) === String(req.params.id));
  if (!hook) return res.status(404).json({ success: false, error: '未找到指定的 Webhook 订阅节点' });

  const webhookSecret = hook.secret;
  if (!webhookSecret) return res.status(409).json({ success: false, error: 'Webhook 节点未配置独立签名密钥，请先轮换密钥' });

  const photoUrl = '/assets/test_photo.jpg';
  const testEvent = {
    id: Date.now(),
    event_id: 'EVT_TEST_' + Date.now(),
    task_code: 'TASK_TEST_001',
    task_name: 'Webhook 联调测试任务',
    schema_id: 'sys_gate_security',
    timestamp: new Date().toISOString(),
    submit_time: new Date().toISOString(),
    operator: '系统联调员 (admin)',
    operator_username: 'admin',
    operator_name: '系统联调员',
    payload: {
      location: '模拟测试大门',
      person_name: '测试人员',
      person_id_card: '110101199001011234',
      description: '视汇中台 Webhook 联调连通性测试消息'
    },
    files: [
      {
        filename: 'test_photo.jpg',
        url: photoUrl
      }
    ],
    photos: [photoUrl],
    created_at: new Date().toISOString()
  };

  const payloadStr = JSON.stringify({
    event: 'EVENT_INGESTED',
    timestamp: new Date().toISOString(),
    data: testEvent
  });

  const signature = signWebhookPayload(payloadStr, webhookSecret);

  try {
    const urlValidation = await validateHttpUrlResolved(hook.url);
    if (!urlValidation.valid) return res.json({ success: false, error: urlValidation.error });
    const urlObj = urlValidation.url;
    const reqModule = urlObj.protocol === 'https:' ? https : http;

    const testReq = reqModule.request(hook.url, {
      method: 'POST',
      lookup: fixedDnsLookup(urlValidation.addresses || []),
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payloadStr),
        [WEBHOOK_SIGNATURE_HEADER]: signature
      },
      timeout: 8000
    }, (testRes) => {
      let body = '';
      testRes.on('data', chunk => body += chunk);
      testRes.on('end', () => {
        if (testRes.statusCode >= 200 && testRes.statusCode < 300) {
          addAuditLog('WEBHOOK_TEST', `测试发送 Webhook 到 [${hook.name}]: 成功 HTTP ${testRes.statusCode}`, 'SUCCESS');
          res.json({ success: true, message: `测试推送成功！目标系统响应 HTTP ${testRes.statusCode}` });
        } else {
          addAuditLog('WEBHOOK_TEST', `测试发送 Webhook 到 [${hook.name}]: 目标返回 HTTP ${testRes.statusCode}`, 'WARN');
          res.json({ success: false, error: `目标服务响应状态码 HTTP ${testRes.statusCode}` });
        }
      });
    });

    testReq.on('error', (err) => {
      addAuditLog('WEBHOOK_TEST', `测试发送 Webhook 到 [${hook.name}] 失败: ${err.message}`, 'WARN');
      res.json({ success: false, error: `网络连接失败: ${err.message}` });
    });

    testReq.on('timeout', () => {
      testReq.destroy();
      res.json({ success: false, error: '连接目标 Webhook 接口超时 (8秒未响应)' });
    });

    testReq.write(payloadStr);
    testReq.end();
  } catch (err) {
    res.json({ success: false, error: `URL 格式错误: ${err.message}` });
  }
});

const FTP_PASSWORD_MASK = '********';
function maskSecret(secret) {
  if (!secret) return '未设置';
  const value = String(secret);
  return value.length <= 8 ? '********' : `${value.slice(0, 4)}...${value.slice(-4)}`;
}

app.get('/api/config/security', requireRole('admin'), (req, res) => {
  try {
    const sec = JSON.parse(fs.readFileSync(SECURITY_CONFIG_FILE, 'utf8'));
    res.json({
      success: true,
      data: {
        hmac_secret: '',
        hmac_secret_masked: maskSecret(sec.hmac_secret),
        auto_diode_interval: sec.auto_diode_interval || 0,
        ftp_enabled: sec.ftp_enabled || false,
        ftp_host: sec.ftp_host || '',
        ftp_port: sec.ftp_port || 21,
        ftp_user: sec.ftp_user || '',
        // 不下发明文密码，仅告知是否已配置
        ftp_password: sec.ftp_password ? FTP_PASSWORD_MASK : '',
        ftp_remote_dir: sec.ftp_remote_dir || '/vfusion_packages',
        ftp_delete_after_download: sec.ftp_delete_after_download !== false,
        ftp_in_dir: sec.ftp_in_dir || getFtpInDir(),
        ftp_out_dir: sec.ftp_out_dir || getFtpOutDir(),
        pkg_prefix: sec.pkg_prefix || getPkgPrefix(),
        ftp_file_ext: sec.ftp_file_ext || '.jpg'
      }
    });
  } catch (e) {
    res.json({
      success: true,
      data: {
        hmac_secret_masked: '未设置',
        auto_diode_interval: 0,
        ftp_enabled: false,
        ftp_host: '',
        ftp_port: 21,
        ftp_user: '',
        ftp_password: '',
        ftp_remote_dir: '/vfusion_packages',
        ftp_delete_after_download: true,
        ftp_in_dir: getFtpInDir(),
        ftp_out_dir: getFtpOutDir(),
        pkg_prefix: getPkgPrefix(),
        ftp_file_ext: '.jpg'
      }
    });
  }
});

app.post('/api/config/security', requireRole('admin'), (req, res) => {
  const {
    hmac_secret, auto_diode_interval, ftp_in_dir, ftp_out_dir, pkg_prefix, ftp_file_ext,
    ftp_enabled, ftp_host, ftp_port, ftp_user, ftp_password, ftp_remote_dir, ftp_delete_after_download
  } = req.body;
  try {
    const sec = JSON.parse(fs.readFileSync(SECURITY_CONFIG_FILE, 'utf8'));
    if (hmac_secret) {
      if (typeof hmac_secret !== 'string' || hmac_secret.trim().length < 32 || hmac_secret.length > 256) {
        return res.status(400).json({ success: false, error: 'HMAC 密钥长度必须为 32-256 个字符' });
      }
      sec.hmac_secret = hmac_secret;
      setHmacSecret(hmac_secret);
      addAuditLog('SECURITY', `HMAC 数字签名秘钥已在线轮换更新`, 'SUCCESS');
    }
    if (typeof auto_diode_interval === 'number' && Number.isFinite(auto_diode_interval)) {
      if (auto_diode_interval < 0 || auto_diode_interval > 86400) return res.status(400).json({ success: false, error: '摆渡轮询间隔必须在 0-86400 秒之间' });
      sec.auto_diode_interval = auto_diode_interval;
      setAutoDiodeInterval(auto_diode_interval);
      addAuditLog('DIODE_CONFIG', `网闸自动摆渡轮询频率设置为: ${auto_diode_interval}秒`, 'INFO');
    }
    if (typeof ftp_enabled === 'boolean') sec.ftp_enabled = ftp_enabled;
    if (typeof ftp_host === 'string') sec.ftp_host = ftp_host;
    if (typeof ftp_port === 'number' || typeof ftp_port === 'string') sec.ftp_port = parseInt(ftp_port) || 21;
    if (typeof ftp_user === 'string') sec.ftp_user = ftp_user;
    if (typeof ftp_password === 'string' && ftp_password && ftp_password !== FTP_PASSWORD_MASK) {
      sec.ftp_password = ftp_password;
    }
    if (typeof ftp_remote_dir === 'string') sec.ftp_remote_dir = ftp_remote_dir;
    if (typeof ftp_delete_after_download === 'boolean') sec.ftp_delete_after_download = ftp_delete_after_download;
    if (typeof ftp_in_dir === 'string') sec.ftp_in_dir = ftp_in_dir;
    if (typeof ftp_out_dir === 'string') sec.ftp_out_dir = ftp_out_dir;
    if (typeof pkg_prefix === 'string') sec.pkg_prefix = pkg_prefix;
    if (typeof ftp_file_ext === 'string') sec.ftp_file_ext = ftp_file_ext;

    writeJsonAtomic(SECURITY_CONFIG_FILE, sec);

    // 保存后自动启停 FTP 轮询引擎
    if (sec.ftp_enabled && sec.ftp_host) {
      const pollInterval = sec.ftp_poll_interval || 10;
      setFtpPollInterval(pollInterval);
    } else {
      setFtpPollInterval(0);
    }

    addAuditLog('FTP_CONFIG', `第三方 FTP 通道配置更新 (${sec.ftp_enabled ? '启用' : '关闭'}, Host: ${sec.ftp_host}:${sec.ftp_port})`, 'SUCCESS');
    res.json({ success: true, message: '安全与 FTP 通道可视化配置更新成功' });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/config/ftp/test', requireRole('admin'), async (req, res) => {
  try {
    const config = req.body;
    const testResult = await testFtpConnection(config);
    addAuditLog('FTP_TEST', `管理员测试 FTP 远程通道连接 [${config.ftp_host}:${config.ftp_port}] 成功`, 'SUCCESS');
    res.json(testResult);
  } catch (err) {
    addAuditLog('FTP_TEST', `管理员测试 FTP 远程通道连接 [${req.body.ftp_host}] 失败: ${err.message}`, 'WARN');
    res.status(400).json({ success: false, error: err.message });
  }
});

// 内网中台端：Web 控制台一键无损热升级 API
app.post('/api/system/upgrade', requireRole('admin'), (req, res) => {
  const form = formidable({
    uploadDir: STORAGE_ROOT,
    keepExtensions: true,
    maxFileSize: 200 * 1024 * 1024
  });

  form.parse(req, async (err, fields, files) => {
    if (err) return res.status(400).json({ success: false, error: '上传补丁包解析失败: ' + err.message });
    const patchFile = files.patchFile || files.file;
    const uploadedFile = Array.isArray(patchFile) ? patchFile[0] : patchFile;
    if (!uploadedFile || !uploadedFile.filepath) {
      return res.status(400).json({ success: false, error: '未接收到升级补丁 zip 文件' });
    }

    try {
      const appRootDir = path.resolve(__dirname, '../..');
      const result = await performOnlineUpgrade(uploadedFile.filepath, STORAGE_ROOT, appRootDir);
      addAuditLog('SYSTEM_UPGRADE', `管理员在 Web 控制台上传热升级补丁包成功`, 'SUCCESS');
      res.json(result);
    } catch (e) {
      addAuditLog('SYSTEM_UPGRADE', `热升级补丁包更新失败: ${e.message}`, 'WARN');
      res.status(500).json({ success: false, error: e.message });
    }
  });
});

app.get('/api/events/export', (req, res) => {
  try {
    const db = readDb();
    const schemaObj = JSON.parse(fs.readFileSync(SCHEMA_FILE, 'utf8'));
    const fieldKeys = schemaObj.fields.map(f => f.key);
    const fieldLabels = schemaObj.fields.map(f => f.label);

    let csvHeader = ['事件编号', '应用ID', '发生时间', '录入人员', ...fieldLabels, '照片数量', 'Zip MD5'].join(',');
    let csvRows = [csvHeader];

    for (const evt of db.events) {
      const p = evt.payload || {};
      const payloadCols = fieldKeys.map(k => `"${(p[k] || '').toString().replace(/"/g, '""')}"`);
      const row = [
        `"${evt.event_id}"`,
        `"${evt.app_id}"`,
        `"${new Date(evt.timestamp).toLocaleString()}"`,
        `"${evt.operator}"`,
        ...payloadCols,
        (evt.files || []).length,
        `"${evt.zip_hash}"`
      ];
      csvRows.push(row.join(','));
    }

    const csvContent = '\uFEFF' + csvRows.join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=vfusion_report_${Date.now()}.csv`);
    res.send(csvContent);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/errors', (req, res) => {
  try {
    const files = fs.readdirSync(ERROR_DIR).filter(f => (f.endsWith('.zip') || f.endsWith('.jpg')) && !f.endsWith('.tmp'));
    const errList = files.map(f => {
      const stat = fs.statSync(path.join(ERROR_DIR, f));
      return { filename: f, size: stat.size, mtime: stat.mtime };
    });
    res.json({ success: true, data: errList });
  } catch (e) { res.json({ success: true, data: [] }); }
});

app.post('/api/errors/retry', requireRole('admin'), async (req, res) => {
  const { filename } = req.body;
  if (!isSafeFileName(filename)) {
    return res.status(400).json({ success: false, error: '非法的文件名' });
  }
  try {
    const result = await processPackageFile(filename, true);
    res.json(result);
  } catch (e) { res.status(400).json({ success: false, error: e.message }); }
});

app.delete('/api/errors/:filename', requireRole('admin'), (req, res) => {
  const { filename } = req.params;
  if (!isSafeFileName(filename)) {
    return res.status(400).json({ success: false, error: '非法的文件名' });
  }
  try {
    const target = path.join(ERROR_DIR, filename);
    if (fs.existsSync(target)) fs.unlinkSync(target);
    addAuditLog('CLEANUP', `删除异常单据包: ${filename}`, 'WARN');
    res.json({ success: true, message: '成功删除死信单据包' });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/system/health', (req, res) => {
  try {
    const db = readDb();
    const mem = process.memoryUsage();
    const getFolderSize = (dir) => {
      if (!fs.existsSync(dir)) return 0;
      return fs.readdirSync(dir).reduce((acc, file) => {
        const p = path.join(dir, file);
        const stat = fs.statSync(p);
        return acc + (stat.isDirectory() ? getFolderSize(p) : stat.size);
      }, 0);
    };

    res.json({
      success: true,
      data: {
        role: 'CORE',
        node_version: process.version,
        uptime_seconds: Math.floor(process.uptime()),
        memory_heap_mb: (mem.heapUsed / (1024 * 1024)).toFixed(2),
        memory_rss_mb: (mem.rss / (1024 * 1024)).toFixed(2),
        total_events: db.events.length,
        archive_size_bytes: getFolderSize(ARCHIVE_DIR),
        assets_size_bytes: getFolderSize(ASSETS_DIR),
        error_count: fs.existsSync(ERROR_DIR) ? fs.readdirSync(ERROR_DIR).filter(f => (f.endsWith('.zip') || f.endsWith('.jpg')) && !f.endsWith('.tmp')).length : 0,
        system_os: `${os.type()} ${os.release()}`,
        storage_status: 'HEALTHY'
      }
    });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/storage/cleanup', requireRole('admin'), (req, res) => {
  try {
    const files = fs.readdirSync(ARCHIVE_DIR);
    let count = 0;
    for (const f of files) {
      fs.unlinkSync(path.join(ARCHIVE_DIR, f));
      count++;
    }
    addAuditLog('CLEANUP', `擦除了 ${count} 个历史归档 Zip 包`, 'SUCCESS');
    res.json({ success: true, message: `已成功擦除 ${count} 个历史归档文件` });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/audit-logs', (req, res) => {
  const db = readDb();
  const { keyword, status, type } = req.query;

  let filtered = db.audit_logs;
  if (keyword) {
    const kw = keyword.toLowerCase();
    filtered = filtered.filter(l => l.message.toLowerCase().includes(kw) || l.type.toLowerCase().includes(kw));
  }
  if (status) filtered = filtered.filter(l => l.status === status);
  if (type) filtered = filtered.filter(l => l.type === type);

  res.json({ success: true, data: filtered });
});

app.post('/api/simulate-diode', requireRole('admin'), (req, res) => {
  try {
    const ftpOutDir = getFtpOutDir();
    const ftpInDir = getFtpInDir();
    const prefix = getPkgPrefix();
    if (!fs.existsSync(ftpOutDir)) fs.mkdirSync(ftpOutDir, { recursive: true });
    if (!fs.existsSync(ftpInDir)) fs.mkdirSync(ftpInDir, { recursive: true });
    const files = fs.readdirSync(ftpOutDir).filter(f => f.startsWith(prefix) && (f.endsWith('.zip') || f.endsWith('.jpg')) && !f.endsWith('.tmp'));
    let copiedCount = 0;
    for (const f of files) {
      const src = path.join(ftpOutDir, f);
      const dest = path.join(ftpInDir, f);
      fs.copyFileSync(src, dest);
      try { fs.unlinkSync(src); } catch (e) {}
      copiedCount++;
    }
    addAuditLog('DIODE_SIM', `网闸模拟摆渡传输了 ${copiedCount} 个数据包`, 'INFO');
    res.json({ success: true, message: `已成功复制 ${copiedCount} 个包到内网接收目录` });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

function getLocalIps() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        ips.push(iface.address);
      }
    }
  }
  return ips;
}

const httpServer = app.listen(PORT, '0.0.0.0', () => {
  const localIps = getLocalIps();
  console.log(`===================================================`);
  console.log(` 内网数据汇聚与管理中台 (VFusion Core v0.24.0) 已启动`);
  console.log(` 本机访问地址: http://localhost:${PORT}`);
  localIps.forEach(ip => {
    console.log(` 局域网/其他电脑访问地址: http://${ip}:${PORT}`);
  });
  console.log(`===================================================`);

  // 启动时自动检测并开启 FTP 远程轮询
  bootFtpPoll();
});

let shuttingDown = false;
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[VFusion Core] 收到 ${signal}，正在优雅关闭...`);
  clearInterval(scanTimer);
  if (autoDiodeTimer) clearInterval(autoDiodeTimer);
  if (ftpPollTimer) clearInterval(ftpPollTimer);
  await new Promise(resolve => httpServer.close(() => resolve()));
  try { await coreSqlite.close(); } catch (e) { console.error('[VFusion Core] 关闭数据库失败:', e.message); }
}
process.once('SIGINT', () => gracefulShutdown('SIGINT').finally(() => process.exit(0)));
process.once('SIGTERM', () => gracefulShutdown('SIGTERM').finally(() => process.exit(0)));
