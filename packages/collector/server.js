require('../common/env_loader').initEnv();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { formidable } = require('formidable');
const { packEventPackage } = require('../common/packager');
const { DEFAULT_FORM_SCHEMA, setHmacSecret } = require('../common/protocol');
const { hashPassword, verifyPassword, generateToken, setTokenSecret } = require('../common/auth');
const { authMiddleware, assetAuthMiddleware, requireRole } = require('../common/auth_middleware');
const { isSafeIdentifier, getImageExtension, validateImageMagic, resolveInside, assertJsonObject } = require('../common/security_utils');
const { writeJsonAtomic: writeJsonAtomicSafe, updateJsonAtomic } = require('../common/json_store');
const { createRateLimiter } = require('../common/rate_limiter');
const { normalizeCoordinates, normalizeMonitoringPoint, readMonitoringPoints, findMonitoringPoint, applyMonitoringPoint, createMonitoringPointId, monitoringPointsToCsv } = require('../common/monitoring_points');
const { testFtpConnection, uploadToRemoteFtp } = require('../common/ftp_client');
const { performOnlineUpgrade } = require('../common/system_upgrader');

const app = express();
const PORT = process.env.COLLECTOR_PORT || process.env.PORT || 5001;

const STORAGE_ROOT = path.resolve(__dirname, '../../storage');
const SECURITY_CONFIG_FILE = path.join(STORAGE_ROOT, 'security.json');
const COLLECTOR_SCHEMA_FILE = path.join(STORAGE_ROOT, 'collector_schema.json');
const COLLECTOR_DB_FILE = path.join(STORAGE_ROOT, 'collector_db.json');

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

const OUTPUT_FTP_DIR = getFtpOutDir();
if (!fs.existsSync(OUTPUT_FTP_DIR)) {
  fs.mkdirSync(OUTPUT_FTP_DIR, { recursive: true });
}

function writeJsonAtomic(filePath, data) {
  return writeJsonAtomicSafe(filePath, data);
}

if (!fs.existsSync(COLLECTOR_SCHEMA_FILE)) {
  writeJsonAtomic(COLLECTOR_SCHEMA_FILE, DEFAULT_FORM_SCHEMA);
}

// 加载共享密钥：视频网端签名用的 HMAC 密钥必须与内网端一致，否则数据包无法通过校验
function loadSecurityConfig() {
  try {
    if (fs.existsSync(SECURITY_CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(SECURITY_CONFIG_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('[VFusion Collector] 读取安全配置失败:', e.message);
  }
  return null;
}

function maskSecret(value) {
  if (!value) return '';
  const text = String(value);
  return text.length <= 8 ? '********' : `${text.slice(0, 3)}********${text.slice(-3)}`;
}

(function bootSecrets() {
  let sec = loadSecurityConfig();
  if (!sec) {
    sec = {
      hmac_secret: crypto.randomBytes(32).toString('hex'),
      token_secret: crypto.randomBytes(32).toString('hex'),
      pkg_prefix: 'vfusion_'
    };
    writeJsonAtomic(SECURITY_CONFIG_FILE, sec);
    console.log('[VFusion Collector] 已生成随机 HMAC 与 Token 密钥并写入 security.json');
  }
  let mutated = false;
  if (!sec.hmac_secret || sec.hmac_secret === 'vfusion_secret_key_2026') {
    sec.hmac_secret = crypto.randomBytes(32).toString('hex');
    mutated = true;
    console.warn('[VFusion Collector] 已轮换缺失或泄露的默认 HMAC 密钥');
  }
  if (!sec.token_secret) {
    sec.token_secret = crypto.randomBytes(32).toString('hex');
    mutated = true;
  }
  if (mutated) writeJsonAtomic(SECURITY_CONFIG_FILE, sec);

  setHmacSecret(sec.hmac_secret);
  setTokenSecret(sec.token_secret);
  console.log('[VFusion Collector] HMAC 签名密钥已加载');
})();

const COLLECTOR_ASSETS_DIR = path.join(STORAGE_ROOT, 'collector_assets');
if (!fs.existsSync(COLLECTOR_ASSETS_DIR)) fs.mkdirSync(COLLECTOR_ASSETS_DIR, { recursive: true });

const SQLiteStorageEngine = require('../common/db_sqlite');

const collectorSqlite = new SQLiteStorageEngine(path.join(STORAGE_ROOT, 'vfusion_collector.db'));
const loginRateLimiter = createRateLimiter({ windowMs: 60_000, max: 10, keyFn: req => `${req.ip || 'unknown'}:${String(req.body?.username || '').slice(0, 64)}` });
const MONITORING_POINTS_FILE = path.join(STORAGE_ROOT, 'monitoring_points.json');
if (!fs.existsSync(MONITORING_POINTS_FILE)) writeJsonAtomic(MONITORING_POINTS_FILE, []);

// 初始化视频网本地数据库（用户与审计日志）
function readCollectorDb() {
  if (!fs.existsSync(COLLECTOR_DB_FILE)) {
    // 初始密码由环境变量注入，未设置时随机生成并仅打印一次，避免固定弱口令
    const generated = {};
    const initialPwd = (envKey, account) => {
      const fromEnv = process.env[envKey];
      if (fromEnv) return fromEnv;
      const random = crypto.randomBytes(9).toString('base64url');
      generated[account] = random;
      return random;
    };

    const collectorAdminUsername = process.env.VFUSION_COLLECTOR_ADMIN_USERNAME || 'admin';
    const defaultDb = {
      users: [
        { id: 1, username: collectorAdminUsername, password: hashPassword(initialPwd('VFUSION_COLLECTOR_ADMIN_PASSWORD', collectorAdminUsername)), name: '视频网管理员', role: 'admin', status: 'active' }
      ],
      audit_logs: [
        { id: 1, timestamp: new Date().toISOString(), type: 'SYSTEM_INIT', message: '视频网采集端完成首次初始化', status: 'INFO' }
      ]
    };

    if (Object.keys(generated).length > 0) {
      console.log('\n=============== VFusion 视频网端初始账号 ===============');
      console.log(` 首次初始化，已为超级管理员 [${collectorAdminUsername}] 账号生成随机初始密码，仅显示这一次：`);
      for (const [account, pwd] of Object.entries(generated)) {
        console.log(`   ${account.padEnd(10)} : ${pwd}`);
      }
      console.log(' 也可通过环境变量预设: VFUSION_COLLECTOR_ADMIN_USERNAME 与 VFUSION_COLLECTOR_ADMIN_PASSWORD');
      console.log(' 其他业务/审计账号请在登录控制台后由管理员账号手动创建。');
      console.log('=========================================================\n');
    }

    writeJsonAtomic(COLLECTOR_DB_FILE, defaultDb);
    return defaultDb;
  }
  try {
    const db = JSON.parse(fs.readFileSync(COLLECTOR_DB_FILE, 'utf8'));
    if (!db || typeof db !== 'object' || Array.isArray(db)) throw new Error('数据库格式无效');
    if (!Array.isArray(db.users)) db.users = [];
    if (!Array.isArray(db.audit_logs)) db.audit_logs = [];
    if (db.users.length === 0) {
      const username = process.env.VFUSION_COLLECTOR_ADMIN_USERNAME || 'admin';
      const configuredPassword = process.env.VFUSION_COLLECTOR_ADMIN_PASSWORD;
      const initialPassword = configuredPassword || crypto.randomBytes(9).toString('base64url');
      db.users.push({ id: 1, username, password: hashPassword(initialPassword), name: '视频网管理员', role: 'admin', status: 'active' });
      writeJsonAtomic(COLLECTOR_DB_FILE, db);
      if (!configuredPassword) {
        console.warn(`[VFusion Collector] 检测到空用户表，已恢复超级管理员 [${username}]。本次随机初始密码: ${initialPassword}`);
      }
    }
    return db;
  } catch (e) {
    const username = process.env.VFUSION_COLLECTOR_ADMIN_USERNAME || 'admin';
    const configuredPassword = process.env.VFUSION_COLLECTOR_ADMIN_PASSWORD;
    const initialPassword = configuredPassword || crypto.randomBytes(9).toString('base64url');
    const recovered = {
      users: [{ id: 1, username, password: hashPassword(initialPassword), name: '视频网管理员', role: 'admin', status: 'active' }],
      audit_logs: [{ id: Date.now(), timestamp: new Date().toISOString(), type: 'SYSTEM_RECOVERY', message: '视频网采集端用户数据库已恢复', status: 'WARN' }]
    };
    writeJsonAtomic(COLLECTOR_DB_FILE, recovered);
    if (!configuredPassword) console.warn(`[VFusion Collector] 用户数据库无法读取，已恢复超级管理员 [${username}]。本次随机初始密码: ${initialPassword}`);
    return recovered;
  }
}

function saveCollectorDb(db) {
  writeJsonAtomic(COLLECTOR_DB_FILE, db);
}

function addCollectorAuditLog(type, message, status = 'SUCCESS') {
  updateJsonAtomic(COLLECTOR_DB_FILE, { users: [], audit_logs: [] }, db => {
    if (!db || typeof db !== 'object' || Array.isArray(db)) db = { users: [], audit_logs: [] };
    if (!Array.isArray(db.audit_logs)) db.audit_logs = [];
    db.audit_logs.unshift({ id: Date.now(), timestamp: new Date().toISOString(), type, message, status });
    if (db.audit_logs.length > 500) db.audit_logs = db.audit_logs.slice(0, 500);
    return db;
  });
  collectorSqlite.addAuditLog(type, message, status).catch(err => console.error('[VFusion Collector] 审计日志写入失败:', err.message));
}

// 仅允许同源与显式白名单来源，避免任意站点携带凭据调用内部接口
const ALLOWED_ORIGINS = (process.env.VFUSION_ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

app.use((req, res, next) => {
  const origin = req.get('Origin');
  if (!origin) return next();
  const host = req.get('Host');
  const sameOrigin = host && (origin === `http://${host}` || origin === `https://${host}`);
  if (sameOrigin || ALLOWED_ORIGINS.includes(origin)) return next();
  return res.status(403).json({ success: false, error: 'CORS: 来源不被允许' });
});
app.use(cors({ origin: true }));
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});
app.get('/favicon.ico', (req, res) => res.status(204).end());

// 统一鉴权：除登录与静态资源外，所有 /api 路由必须携带有效 Token
app.use('/api', authMiddleware({
  publicPaths: ['/auth/login'],
  loadUser: (id) => (readCollectorDb().users || []).find(u => u.id === id) || null
}));
const protectedAssetAuth = assetAuthMiddleware({
  loadUser: (id) => (readCollectorDb().users || []).find(u => u.id === id) || null
});
app.use('/collector-assets', protectedAssetAuth, express.static(COLLECTOR_ASSETS_DIR, { fallthrough: false }));
app.use('/assets', protectedAssetAuth, express.static(COLLECTOR_ASSETS_DIR, { fallthrough: false }));

// 表单 Schema 配置 API（视频网发布端与可视化构建器）
app.get('/api/schema', (req, res) => {
  const { app_id } = req.query;
  if (app_id && !isSafeIdentifier(String(app_id))) return res.status(400).json({ success: false, error: 'app_id 格式无效' });
  const targetFile = app_id ? resolveInside(STORAGE_ROOT, `schema_${app_id}.json`) : COLLECTOR_SCHEMA_FILE;
  try {
    const fileToRead = fs.existsSync(targetFile) ? targetFile : (fs.existsSync(COLLECTOR_SCHEMA_FILE) ? COLLECTOR_SCHEMA_FILE : null);
    if (fileToRead && fs.existsSync(fileToRead)) {
      res.json({ success: true, data: JSON.parse(fs.readFileSync(fileToRead, 'utf8')) });
    } else {
      res.json({ success: true, data: DEFAULT_FORM_SCHEMA });
    }
  } catch (e) {
    res.json({ success: true, data: DEFAULT_FORM_SCHEMA });
  }
});

app.post('/api/schema', requireRole('admin'), (req, res) => {
  try {
    const newSchema = assertJsonObject(req.body, 'Schema');
    const appId = newSchema.app_id || 'sys_gate_security';
    if (!isSafeIdentifier(String(appId))) return res.status(400).json({ success: false, error: 'app_id 格式无效' });
    if (newSchema.fields !== undefined && (!Array.isArray(newSchema.fields) || newSchema.fields.length > 200)) return res.status(400).json({ success: false, error: 'Schema 字段数量超限' });
    const targetFile = resolveInside(STORAGE_ROOT, `schema_${appId}.json`);
    writeJsonAtomic(targetFile, newSchema);
    writeJsonAtomic(COLLECTOR_SCHEMA_FILE, newSchema);
    addCollectorAuditLog('SCHEMA_UPDATE', `视频网端表单 Schema 已更新 (App: ${appId}, 包含 ${newSchema.fields ? newSchema.fields.length : 0} 个字段)`, 'SUCCESS');
    res.json({ success: true, message: '视频网端表单 Schema 更新成功' });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
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
    addCollectorAuditLog('MONITORING_POINT_IMPORT', `导入监控点位 ${normalized.length} 条（${mode === 'replace' ? '覆盖' : '合并'}）`, 'SUCCESS');
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
    addCollectorAuditLog('MONITORING_POINT_ADD', `用户 [${req.user?.username || 'unknown'}] 新增监控点位 [${point.point_id}]`, 'SUCCESS');
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
    addCollectorAuditLog('MONITORING_POINT_UPDATE', `更新监控点位 [${point.point_id}]`, 'SUCCESS');
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
    addCollectorAuditLog('MONITORING_POINT_TOGGLE', `${point.enabled ? '启用' : '停用'}监控点位 [${point.point_id}]`, 'SUCCESS');
    res.json({ success: true, data: point });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

// 涉事人员库 API
app.get('/api/personnel', (req, res) => {
  const db = readCollectorDb();
  let list = db.personnel || [];
  const taskCode = req.query.task_code;
  if (taskCode) {
    list = list.filter(p => p.task_code === taskCode || (p.task_codes && p.task_codes.includes(taskCode)));
  }
  res.json({ success: true, data: list });
});

app.post('/api/personnel', (req, res) => {
  const { name, id_card, domicile } = req.body;
  if (!name || !id_card) return res.status(400).json({ success: false, error: '姓名与身份证号不能为空' });

  const db = readCollectorDb();
  if (!db.personnel) db.personnel = [];

  const existingIdx = db.personnel.findIndex(p => p.id_card === id_card || p.name === name);
  const personRecord = { id: Date.now(), name, id_card, domicile: domicile || '' };

  if (existingIdx >= 0) {
    db.personnel[existingIdx] = { ...db.personnel[existingIdx], ...personRecord };
  } else {
    db.personnel.unshift(personRecord);
  }

  saveCollectorDb(db);
  res.json({ success: true, message: '人员档案保存成功', data: personRecord });
});

// 编辑涉事人员档案 (管理员)
app.put('/api/personnel/:id', requireRole('admin'), (req, res) => {
  const { id } = req.params;
  const { name, id_card, domicile } = req.body;
  const db = readCollectorDb();
  if (!db.personnel) db.personnel = [];

  const idx = db.personnel.findIndex(p => String(p.id) === String(id));
  if (idx < 0) return res.status(404).json({ success: false, error: '涉事人员记录不存在' });

  db.personnel[idx] = {
    ...db.personnel[idx],
    name: name !== undefined ? name : db.personnel[idx].name,
    id_card: id_card !== undefined ? id_card : db.personnel[idx].id_card,
    domicile: domicile !== undefined ? domicile : db.personnel[idx].domicile
  };

  saveCollectorDb(db);
  addCollectorAuditLog('PERSONNEL_EDIT', `编辑涉事人员档案 [${db.personnel[idx].name}]`, 'SUCCESS');
  res.json({ success: true, message: '人员档案已成功修改', data: db.personnel[idx] });
});

// 删除涉事人员档案 (管理员)
app.delete('/api/personnel/:id', requireRole('admin'), (req, res) => {
  const { id } = req.params;
  const db = readCollectorDb();
  if (!db.personnel) db.personnel = [];

  const idx = db.personnel.findIndex(p => String(p.id) === String(id));
  if (idx < 0) return res.status(404).json({ success: false, error: '涉事人员记录不存在' });

  const deleted = db.personnel.splice(idx, 1)[0];
  saveCollectorDb(db);
  addCollectorAuditLog('PERSONNEL_DELETE', `删除涉事人员档案 [${deleted.name}]`, 'WARN');
  res.json({ success: true, message: '人员档案已成功删除' });
});

// 登录 API
app.post('/api/auth/login', loginRateLimiter, (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ success: false, error: '用户名与密码不能为空' });
  }

  const db = readCollectorDb();
  const user = db.users.find(u => u.username === username);
  const pwdCheck = user ? verifyPassword(password, user.password) : { valid: false, needsUpgrade: false };

  if (!user || !pwdCheck.valid) {
    addCollectorAuditLog('AUTH_FAIL', `视频网用户尝试登录失败 (用户名: ${username})`, 'WARN');
    return res.status(401).json({ success: false, error: '用户名或密码错误' });
  }

  if (user.status && user.status !== 'active' && user.status !== 'ACTIVE') {
    return res.status(403).json({ success: false, error: '该账号已被禁用，请联系管理员' });
  }

  // 历史明文/旧哈希密码在首次成功登录后自动升级为 PBKDF2
  if (pwdCheck.needsUpgrade) {
    user.password = hashPassword(password);
    saveCollectorDb(db);
    addCollectorAuditLog('USER_PWD_UPGRADE', `视频网用户 [${user.username}] 的密码已升级为 PBKDF2 存储`, 'INFO');
  }

  addCollectorAuditLog('AUTH_SUCCESS', `视频网用户 [${user.name}(${user.username})] 登录系统成功 (角色: ${user.role})`, 'SUCCESS');
  res.json({
    success: true,
    data: {
      token: generateToken(user),
      user: { id: user.id, username: user.username, name: user.name, role: user.role }
    }
  });
});

// 用户管理 API（仅管理员）
app.get('/api/users', requireRole('admin'), (req, res) => {
  const db = readCollectorDb();
  res.json({ success: true, data: db.users.map(u => ({ id: u.id, username: u.username, name: u.name, role: u.role, status: u.status })) });
});

app.post('/api/users', requireRole('admin'), (req, res) => {
  const { username, password, name, role } = req.body;
  if (typeof username !== 'string' || !isSafeIdentifier(username) || username.length > 32 || typeof password !== 'string' || password.length < 8 || password.length > 256) {
    return res.status(400).json({ success: false, error: '用户名与初始密码不能为空' });
  }
  if (role && !['admin', 'operator', 'auditor'].includes(role)) return res.status(400).json({ success: false, error: '用户角色无效' });
  const db = readCollectorDb();
  if (db.users.some(u => u.username === username)) {
    return res.status(400).json({ success: false, error: '用户名已存在' });
  }
  const newUser = {
    id: Date.now(),
    username,
    password: hashPassword(password),
    name: name || username,
    role: role || 'operator',
    status: 'active'
  };
  db.users.push(newUser);
  saveCollectorDb(db);
  addCollectorAuditLog('USER_ADD', `新增视频网用户 [${name}(${username})] (角色: ${role})`, 'SUCCESS');
  // 不回传密码哈希
  res.json({ success: true, data: { id: newUser.id, username: newUser.username, name: newUser.name, role: newUser.role, status: newUser.status } });
});

app.put('/api/users/:id/reset-password', requireRole('admin'), (req, res) => {
  const { id } = req.params;
  const { new_password } = req.body;
  if (typeof new_password !== 'string' || new_password.length < 8 || new_password.length > 256) {
    return res.status(400).json({ success: false, error: '新密码不能为空' });
  }
  const db = readCollectorDb();
  const user = db.users.find(u => u.id === parseInt(id));
  if (!user) return res.status(404).json({ success: false, error: '用户不存在' });

  user.password = hashPassword(new_password);
  saveCollectorDb(db);
  addCollectorAuditLog('USER_PWD_RESET', `重置视频网用户 [${user.name}(${user.username})] 密码成功`, 'SUCCESS');
  res.json({ success: true, message: '密码重置成功' });
});

app.delete('/api/users/:id', requireRole('admin'), (req, res) => {
  const { id } = req.params;
  const db = readCollectorDb();
  const idx = db.users.findIndex(u => u.id === parseInt(id));
  if (idx === -1) return res.status(404).json({ success: false, error: '用户不存在' });
  const user = db.users[idx];
  if (user.id === 1 || user.username === (process.env.VFUSION_COLLECTOR_ADMIN_USERNAME || 'admin')) return res.status(403).json({ success: false, error: '超级管理员账号不可删除' });

  db.users.splice(idx, 1);
  saveCollectorDb(db);
  addCollectorAuditLog('USER_DEL', `删除视频网用户 [${user.name}(${user.username})]`, 'WARN');
  res.json({ success: true, message: '用户已删除' });
});

app.put('/api/users/:id', requireRole('admin'), (req, res) => {
  const { id } = req.params;
  const { name, role, status } = req.body;
  if (!name) return res.status(400).json({ success: false, error: '姓名不能为空' });

  const db = readCollectorDb();
  const user = db.users.find(u => u.id === parseInt(id));
  if (!user) return res.status(404).json({ success: false, error: '用户不存在' });
  if (user.id === 1 || user.username === (process.env.VFUSION_COLLECTOR_ADMIN_USERNAME || 'admin')) return res.status(403).json({ success: false, error: '超级管理员账号不可编辑' });

  user.name = name;
  if (role) {
    if (!['admin', 'operator', 'auditor'].includes(role)) return res.status(400).json({ success: false, error: '用户角色无效' });
    user.role = role;
  }
  if (status) user.status = status;

  saveCollectorDb(db);
  addCollectorAuditLog('USER_UPDATE', `更新视频网用户 [${user.name}(${user.username})] (角色: ${user.role}, 状态: ${user.status})`, 'SUCCESS');
  res.json({ success: true, message: '用户信息更新成功', data: { id: user.id, username: user.username, name: user.name, role: user.role, status: user.status } });
});

// 审计日志 API
app.get('/api/audit-logs', (req, res) => {
  const { keyword, status } = req.query;
  const db = readCollectorDb();
  let logs = db.audit_logs;
  if (keyword) {
    logs = logs.filter(l => l.message.toLowerCase().includes(keyword.toLowerCase()) || l.type.toLowerCase().includes(keyword.toLowerCase()));
  }
  if (status) {
    logs = logs.filter(l => l.status === status);
  }
  res.json({ success: true, data: logs });
});

app.get('/api/audit-logs/export', (req, res) => {
  try {
    const db = readCollectorDb();
    let csvHeader = ['序号', '时间戳', '操作类别', '描述明细', '状态级别'].join(',');
    let csvRows = [csvHeader];

    const auditTypeMap = {
      'AUTH_SUCCESS': '用户登录',
      'AUTH_FAIL': '登录失败',
      'USER_ADD': '新增用户',
      'USER_PWD_RESET': '重置密码',
      'USER_DEL': '删除用户',
      'INGEST': '单据发布打包',
      'SCHEMA_UPDATE': 'Schema更新',
      'EXPORT_AUDIT': '导出日志',
      'ERROR': '错误'
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
    addCollectorAuditLog('EXPORT_AUDIT', '导出视频网审计日志 CSV 报表', 'SUCCESS');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=vfusion_collector_audit_${Date.now()}.csv`);
    res.send(csvContent);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 任务管理 API (视频网采集端)
app.get('/api/tasks', async (req, res) => {
  try {
    const currentUser = req.user || { username: 'operator', role: 'operator' };
    const allTasks = await collectorSqlite.getTasks();
    const tasks = currentUser.role === 'admin'
      ? allTasks
      : allTasks.filter(t => t.creator_username === currentUser.username || t.is_shared || (Array.isArray(t.shared_users) && t.shared_users.includes(currentUser.username)));
    const events = await collectorSqlite.getEvents();

    const taskStatsMap = {};
    events.forEach(evt => {
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
    });

    // 针对历史在 events 中出现但 tasks 表中尚无记录的任务，自动补充缺省任务定义
    const knownCodes = new Set(tasks.map(t => t.task_code));
    for (const evt of events) {
      const code = evt.task_code || 'TASK_DEFAULT';
      if (!knownCodes.has(code)) {
        const autoTask = {
          task_code: code,
          task_name: evt.task_name || '历史关联任务',
          description: '系统自动导入的历史关联任务',
          creator_username: 'operator',
          creator_name: '视频网操作员',
          share_code: code,
          is_shared: true,
          status: 'ACTIVE',
          created_at: evt.timestamp || new Date().toISOString()
        };
        await collectorSqlite.saveTask(autoTask);
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

app.post('/api/tasks', async (req, res) => {
  try {
    const { task_name, task_code, description, is_shared } = req.body;
    if (!task_name) return res.status(400).json({ success: false, error: '任务名称不能为空' });

    const user = req.user || { username: 'operator', name: '视频网操作员' };
    const datePrefix = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 8);
    const finalCode = task_code && task_code.trim()
      ? task_code.trim()
      : `TASK_${datePrefix}_${Math.floor(1000 + Math.random() * 9000)}`;
    if (!isSafeIdentifier(finalCode)) return res.status(400).json({ success: false, error: '任务编号格式无效' });

    const existing = await collectorSqlite.getTaskByCode(finalCode);
    if (existing) {
      return res.status(400).json({ success: false, error: `任务编号 [${finalCode}] 已存在` });
    }

    const newTask = await collectorSqlite.saveTask({
      task_code: finalCode,
      task_name: task_name.trim(),
      description: description || '',
      creator_username: user.username,
      creator_name: user.name || user.username,
      share_code: finalCode,
      is_shared: is_shared !== undefined ? Boolean(is_shared) : true,
      status: 'ACTIVE'
    });

    addCollectorAuditLog('TASK_CREATE', `创建新发布任务 [${newTask.task_name}] (编号: ${newTask.task_code})`, 'SUCCESS');
    res.json({ success: true, message: '任务创建成功', data: newTask });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/tasks/join', async (req, res) => {
  try {
    const { share_code } = req.body;
    if (!share_code) return res.status(400).json({ success: false, error: '分享码/任务编号不能为空' });

    const task = await collectorSqlite.getTaskByCode(share_code.trim());
    if (!task) {
      return res.status(404).json({ success: false, error: '未找到匹配的共享任务，请检查分享码' });
    }
    const currentUser = req.user || { username: 'operator', role: 'operator' };
    if (currentUser.role !== 'admin' && !task.is_shared && task.creator_username !== currentUser.username && !(task.shared_users || []).includes(currentUser.username)) {
      return res.status(403).json({ success: false, error: '该任务未向当前用户共享' });
    }

    res.json({ success: true, message: `已成功接入任务: ${task.task_name}`, data: task });
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
    const task = await collectorSqlite.getTaskByCode(code);
    if (!task) return res.status(404).json({ success: false, error: '任务不存在' });

    const currentUser = req.user || { username: 'operator' };
    const isAdmin = currentUser.role === 'admin';
    const isCreator = task.creator_username === currentUser.username;

    if (!isAdmin && !isCreator) {
      return res.status(403).json({ success: false, error: '权限不足：只有任务创建者或管理员可以更新此任务状态' });
    }

    await collectorSqlite.updateTaskStatus(code, status);
    addCollectorAuditLog('TASK_STATUS', `任务 [${code}] 状态更新为 ${status === 'COMPLETED' ? '已完成' : '进行中'}`, 'SUCCESS');
    res.json({ success: true, message: `任务状态已更新为 ${status === 'COMPLETED' ? '已完成' : '进行中'}` });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/users/list', (req, res) => {
  const db = readCollectorDb();
  res.json({
    success: true,
    data: (db.users || []).map(u => ({ username: u.username, name: u.name, role: u.role }))
  });
});

// 设置任务共享（任务创建者 & 管理员可向指定用户共享任务）
app.put('/api/tasks/:code/share', async (req, res) => {
  try {
    const { code } = req.params;
    const { shared_users, is_shared } = req.body;
    const task = await collectorSqlite.getTaskByCode(code);
    if (!task) return res.status(404).json({ success: false, error: '任务不存在' });

    const currentUser = req.user || { username: 'operator' };
    const isAdmin = currentUser.role === 'admin';
    const isCreator = task.creator_username === currentUser.username;

    if (!isAdmin && !isCreator) {
      return res.status(403).json({ success: false, error: '权限不足：只有任务创建者或管理员可以设置任务共享' });
    }

    const updatedTask = await collectorSqlite.updateTaskDetails(code, {
      shared_users: Array.isArray(shared_users) ? shared_users : [],
      is_shared: is_shared !== undefined ? is_shared : task.is_shared
    });
    addCollectorAuditLog('TASK_SHARE_UPDATE', `更新任务 [${code}] 共享配置 (共享指定用户: ${(updatedTask.shared_users || []).join(', ')})`, 'SUCCESS');
    res.json({ success: true, message: '任务共享用户更新成功', data: updatedTask });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 编辑任务 (任务创建者 & 管理员)
app.put('/api/tasks/:code', async (req, res) => {
  try {
    const { code } = req.params;
    const { task_name, description, is_shared, status } = req.body;
    const task = await collectorSqlite.getTaskByCode(code);
    if (!task) return res.status(404).json({ success: false, error: '任务不存在' });

    const currentUser = req.user || { username: 'operator' };
    const isAdmin = currentUser.role === 'admin';
    const isCreator = task.creator_username === currentUser.username;

    if (!isAdmin && !isCreator) {
      return res.status(403).json({ success: false, error: '权限不足：只有任务创建者或管理员可以修改此任务' });
    }

    const updatedTask = await collectorSqlite.updateTaskDetails(code, { task_name, description, is_shared, status });
    addCollectorAuditLog('TASK_EDIT', `修改任务 [${code}] 信息 (名称: ${updatedTask.task_name})`, 'SUCCESS');
    res.json({ success: true, message: '任务信息更新成功', data: updatedTask });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 删除任务 (任务创建者 & 管理员)
app.delete('/api/tasks/:code', async (req, res) => {
  try {
    const { code } = req.params;
    const task = await collectorSqlite.getTaskByCode(code);
    if (!task) return res.status(404).json({ success: false, error: '任务不存在' });

    const currentUser = req.user || { username: 'operator' };
    const isAdmin = currentUser.role === 'admin';
    const isCreator = task.creator_username === currentUser.username;

    if (!isAdmin && !isCreator) {
      return res.status(403).json({ success: false, error: '权限不足：只有任务创建者或管理员可以删除此任务' });
    }

    await collectorSqlite.deleteTask(code);
    addCollectorAuditLog('TASK_DELETE', `删除任务 [${task.task_name}] (${code})`, 'WARN');
    res.json({ success: true, message: '任务已成功删除' });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/tasks/:code', async (req, res) => {
  try {
    const { code } = req.params;
    if (!isSafeIdentifier(code)) return res.status(400).json({ success: false, error: '任务编号格式无效' });
    const task = await collectorSqlite.getTaskByCode(code);
    if (!task) return res.status(404).json({ success: false, error: '任务不存在' });
    const currentUser = req.user || { username: 'operator', role: 'operator' };
    if (currentUser.role !== 'admin' && task.creator_username !== currentUser.username && !task.is_shared && !(task.shared_users || []).includes(currentUser.username)) return res.status(403).json({ success: false, error: '无权访问该任务' });

    const taskEvents = await collectorSqlite.getEvents(null, { taskCode: code, limit: 5000 });

    res.json({ success: true, data: { ...task, events: taskEvents } });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 获取任务下按时间顺序排列的所有图片，并注入权限标识
app.get('/api/tasks/:code/images', async (req, res) => {
  try {
    const { code } = req.params;
    const order = (req.query.order || 'ASC').toUpperCase();
    if (!isSafeIdentifier(code)) return res.status(400).json({ success: false, error: '任务编号格式无效' });
    const task = await collectorSqlite.getTaskByCode(code);
    if (!task) return res.status(404).json({ success: false, error: '任务不存在' });

    const currentUser = req.user || { username: 'operator', role: 'operator' };
    const isAdmin = currentUser.role === 'admin';
    const isCreator = task.creator_username === currentUser.username;
    if (!isAdmin && !isCreator && !task.is_shared && !(task.shared_users || []).includes(currentUser.username)) return res.status(403).json({ success: false, error: '无权访问该任务' });

    const rawImages = await collectorSqlite.getTaskImages(code, order);
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
    const allImages = await collectorSqlite.getTaskImages(null, 'ASC');
    const img = allImages.find(i => i.id === id);
    if (!img) return res.status(404).json({ success: false, error: '未找到对应图片记录' });

    const task = await collectorSqlite.getTaskByCode(img.task_code);
    const currentUser = req.user || { username: 'operator' };
    const isAdmin = currentUser.role === 'admin';
    const isCreator = task && task.creator_username === currentUser.username;
    const isUploader = img.uploader_username === currentUser.username;

    if (!isAdmin && !isCreator && !isUploader) {
      return res.status(403).json({ success: false, error: '权限不足：只有图片上传者、任务创建者或管理员可以修改此图片' });
    }

    const updated = await collectorSqlite.updateImageMetadata(id, { description, location, timestamp });
    addCollectorAuditLog('TASK_IMAGE_EDIT', `修改图片 [${id}] 描述为: ${description || '无'}`, 'SUCCESS');
    res.json({ success: true, message: '图片信息已成功更新', data: updated });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 删除图片 (上传者、任务创建者、管理员)
app.delete('/api/images/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const allImages = await collectorSqlite.getTaskImages(null, 'ASC');
    const img = allImages.find(i => i.id === id);
    if (!img) return res.status(404).json({ success: false, error: '未找到对应图片记录' });

    const task = await collectorSqlite.getTaskByCode(img.task_code);
    const currentUser = req.user || { username: 'operator' };
    const isAdmin = currentUser.role === 'admin';
    const isCreator = task && task.creator_username === currentUser.username;
    const isUploader = img.uploader_username === currentUser.username;

    if (!isAdmin && !isCreator && !isUploader) {
      return res.status(403).json({ success: false, error: '权限不足：只有图片上传者、任务创建者或管理员可以删除此图片' });
    }

    await collectorSqlite.deleteImage(id);
    addCollectorAuditLog('TASK_IMAGE_DELETE', `删除任务 [${img.task_code}] 下的图片 [${id}]`, 'WARN');
    res.json({ success: true, message: '图片已成功删除' });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 单据发布 API
app.post('/api/publish', (req, res) => {
  const form = formidable({
    multiples: true,
    keepExtensions: true,
    maxFileSize: 100 * 1024 * 1024,
    maxFiles: 200,
    maxTotalFileSize: 500 * 1024 * 1024
  });

  form.parse(req, async (err, fields, files) => {
    if (err) {
      console.error('Form parse error:', err);
      return res.status(400).json({ success: false, error: '解析上传表单失败' });
    }

    const uploadedTempPaths = [];
    try {
      const appId = (fields.app_id && fields.app_id[0]) || 'sys_gate_security';
      const bizType = (fields.biz_type && fields.biz_type[0]) || 'person_snapshot';
      const taskName = (fields.task_name && fields.task_name[0]) || '厂区周界安防例行巡检';
      const taskCode = (fields.task_code && fields.task_code[0]) || `TASK_${Date.now()}`;
      if (!isSafeIdentifier(appId) || !isSafeIdentifier(bizType) || !isSafeIdentifier(taskCode)) return res.status(400).json({ success: false, error: '应用、业务类型或任务编号格式无效' });
      const currentUser = req.user || { username: 'operator', name: '视频网操作员' };
      const operatorUsername = currentUser.username;
      const operatorName = currentUser.name || currentUser.username;
      const operator = `${operatorName} (${operatorUsername})`;
      const submitTime = (fields.submit_time && fields.submit_time[0]) || new Date().toISOString();
      const eventId = (fields.event_id && fields.event_id[0]) || `${Date.now()}`;
      if (!isSafeIdentifier(String(eventId))) return res.status(400).json({ success: false, error: '事件编号格式无效' });

      const payload = {};
      for (const [key, value] of Object.entries(fields)) {
        if (!['app_id', 'biz_type', 'task_name', 'task_code', 'operator', 'operator_username', 'operator_name', 'submit_time', 'event_id'].includes(key)) {
          payload[key] = Array.isArray(value) ? value[0] : value;
        }
      }
      const pointId = String(payload.monitoring_point_id || '').trim();
      if (pointId) {
        const point = findMonitoringPoint(readMonitoringPoints(MONITORING_POINTS_FILE), pointId);
        if (!point) return res.status(400).json({ success: false, error: `监控点位 [${pointId}] 不存在或已停用，请先维护点位主数据` });
        applyMonitoringPoint(payload, point);
      } else {
        const coordinates = normalizeCoordinates(payload.longitude, payload.latitude);
        if (coordinates) Object.assign(payload, coordinates);
        if (payload.location) payload.location_source = 'MANUAL';
      }

      // 如果填写了涉事人员姓名与身份证，自动追加入库到人员档案
      if (payload.person_name || payload.person_id_card) {
        const db = readCollectorDb();
        if (!db.personnel) db.personnel = [];
        const existingIdx = db.personnel.findIndex(p => (payload.person_id_card && p.id_card === payload.person_id_card) || (payload.person_name && p.name === payload.person_name));
        const personRec = {
          id: Date.now(),
          name: payload.person_name || '未知',
          id_card: payload.person_id_card || '',
          domicile: payload.person_domicile || '',
          task_code: taskCode || ''
        };
        if (existingIdx >= 0) {
          const oldCodes = db.personnel[existingIdx].task_codes || [];
          if (taskCode && !oldCodes.includes(taskCode)) oldCodes.push(taskCode);
          db.personnel[existingIdx] = { ...db.personnel[existingIdx], ...personRec, task_codes: oldCodes };
        } else {
          personRec.task_codes = taskCode ? [taskCode] : [];
          db.personnel.unshift(personRec);
        }
        saveCollectorDb(db);
      }

      const fileList = [];
      const savedFileRecords = [];
      const eventAssetDir = resolveInside(COLLECTOR_ASSETS_DIR, String(eventId));
      if (!fs.existsSync(eventAssetDir)) fs.mkdirSync(eventAssetDir, { recursive: true });

      if (files.images) {
        const rawFiles = Array.isArray(files.images) ? files.images : [files.images];
        if (rawFiles.length > 200) return res.status(400).json({ success: false, error: '单次上传图片数量不能超过 200 张' });
        for (let i = 0; i < rawFiles.length; i++) {
          const fileObj = rawFiles[i];
          if (fileObj && fileObj.filepath) uploadedTempPaths.push(fileObj.filepath);
          const ext = getImageExtension(fileObj.originalFilename || fileObj.filepath, fileObj.mimetype);
          if (!ext || !fs.statSync(fileObj.filepath).isFile() || !validateImageMagic(fileObj.filepath, ext)) {
            return res.status(400).json({ success: false, error: '仅允许上传有效的 JPG/PNG/GIF/WEBP/BMP 图片' });
          }
          const filename = `${String(i + 1).padStart(3, '0')}${ext}`;
          fileList.push({
            path: fileObj.filepath,
            filename: filename
          });
          const localDest = resolveInside(eventAssetDir, filename);
          fs.copyFileSync(fileObj.filepath, localDest);
          savedFileRecords.push({
            id: `img_${eventId}_${i}_${Math.floor(Math.random() * 10000)}`,
            filename: filename,
            url: `/collector-assets/${eventId}/${filename}`,
            timestamp: submitTime,
            uploader_username: operatorUsername,
            uploader_name: operatorName,
            description: payload.description || payload.notes || '',
            location: payload.location || ''
          });
        }
      }

      let currentSchema = DEFAULT_FORM_SCHEMA;
      const targetSchemaFile = resolveInside(STORAGE_ROOT, `schema_${appId}.json`);
      if (fs.existsSync(targetSchemaFile)) {
        currentSchema = JSON.parse(fs.readFileSync(targetSchemaFile, 'utf8'));
      } else if (fs.existsSync(COLLECTOR_SCHEMA_FILE)) {
        currentSchema = JSON.parse(fs.readFileSync(COLLECTOR_SCHEMA_FILE, 'utf8'));
      }

      const result = await packEventPackage({
        outputDir: getFtpOutDir(),
        appId,
        bizType,
        eventId,
        taskName,
        taskCode,
        operator,
        operatorUsername,
        operatorName,
        submitTime,
        payload,
        files: fileList,
        schema: currentSchema
      });

      // 保存至视频网端本地历史数据库
      await collectorSqlite.saveEvent({
        id: Date.now(),
        app_id: appId,
        biz_type: bizType,
        event_id: eventId,
        task_name: taskName,
        task_code: taskCode,
        timestamp: submitTime,
        operator: operator,
        payload: payload,
        files: savedFileRecords,
        zip_hash: result.pkgName,
        signature: '',
        status: 'PACKED'
      });

      // 确保/更新任务定义记录
      const existingTask = await collectorSqlite.getTaskByCode(taskCode);
      if (!existingTask) {
        await collectorSqlite.saveTask({
          task_code: taskCode,
          task_name: taskName,
          description: '例行采集任务',
          creator_username: operatorUsername,
          creator_name: operatorName,
          share_code: taskCode,
          is_shared: true,
          status: 'ACTIVE'
        });
      } else {
        await collectorSqlite.saveTask({
          ...existingTask,
          task_name: taskName || existingTask.task_name,
          updated_at: new Date().toISOString()
        });
      }

      // 如果配置并启用了第三方远程 FTP 服务器，自动将生成的 Zip 包上传至所有开启的 FTP
      let ftpNotice = ' (远程 FTP 未开启，包已存入本地网闸目录)';
      try {
        const servers = getCollectorFtpServers();
        const activeServers = servers.filter(s => s.ftp_enabled !== false && s.ftp_host);
        if (activeServers.length > 0) {
          let successCount = 0;
          let failCount = 0;
          for (const s of activeServers) {
            try {
              const ftpRes = await uploadToRemoteFtp(result.zipPath, `${result.pkgName}.zip`, s);
              const remoteName = (ftpRes && ftpRes.remoteFileName) ? ftpRes.remoteFileName : `${result.pkgName}.zip`;
              s.last_push_status = `成功: ${new Date().toLocaleTimeString('zh-CN')} 上传 ${remoteName}`;
              addCollectorAuditLog('FTP_UPLOAD', `同步推送单据包至远程 FTP 节点 [${s.name || s.ftp_host} - ${s.ftp_host}:${s.ftp_port || 21}${s.ftp_remote_dir || '/'}/${remoteName}] 成功`, 'SUCCESS');
              successCount++;
            } catch (ftpErr) {
              console.error(`[VFusion Collector] 同步远程 FTP [${s.name || s.ftp_host}] 异常:`, ftpErr);
              s.last_push_status = `异常: ${ftpErr.message}`;
              addCollectorAuditLog('ERROR', `推送到远程 FTP 节点 [${s.name || s.ftp_host}] 失败: ${ftpErr.message}`, 'WARN');
              failCount++;
            }
          }
          saveCollectorFtpServers(servers);
          ftpNotice = ` (已同步推送至 ${successCount}/${activeServers.length} 个开启的 FTP 通道节点${failCount > 0 ? `，${failCount} 个节点报错` : ''})`;
        }
      } catch (e) {
        console.error('[VFusion Collector] 多 FTP 推送引擎异常:', e);
      }

      res.json({
        success: true,
        message: '数据摆渡包已成功生成！' + ftpNotice,
        data: {
          pkgName: result.pkgName,
          zipPath: result.zipPath,
          size: result.size,
          info: result.info,
          ftpNotice: ftpNotice
        }
      });
    } catch (error) {
      console.error('[VFusion Collector] 打包异常:', error);
      addCollectorAuditLog('ERROR', `打包投递失败: ${error.message}`, 'ERROR');
      res.status(500).json({ success: false, error: error.message });
    } finally {
      for (const tempPath of uploadedTempPaths) {
        try { fs.unlinkSync(tempPath); } catch (e) {}
      }
    }
  });
});

function getCollectorFtpServers() {
  try {
    let sec = {};
    if (fs.existsSync(SECURITY_CONFIG_FILE)) {
      sec = JSON.parse(fs.readFileSync(SECURITY_CONFIG_FILE, 'utf8'));
    }
    if (Array.isArray(sec.collector_ftp_servers)) {
      return sec.collector_ftp_servers;
    }
    if (sec.ftp_host) {
      const defaultServer = {
        id: 'ftp_coll_' + Date.now(),
        name: '视频网默认 FTP 节点',
        ftp_host: sec.ftp_host,
        ftp_port: sec.ftp_port || 21,
        ftp_user: sec.ftp_user || '',
        ftp_password: sec.ftp_password || '',
        ftp_remote_dir: sec.ftp_remote_dir || '/vfusion_packages',
        pkg_prefix: sec.pkg_prefix || 'vfusion_',
        ftp_file_ext: sec.ftp_file_ext || '.jpg',
        ftp_enabled: sec.ftp_enabled !== false,
        last_push_status: '初始化归档',
        created_at: new Date().toISOString()
      };
      sec.collector_ftp_servers = [defaultServer];
      writeJsonAtomic(SECURITY_CONFIG_FILE, sec);
      return sec.collector_ftp_servers;
    }
    return [];
  } catch (e) {
    return [];
  }
}

function saveCollectorFtpServers(servers) {
  let sec = {};
  if (fs.existsSync(SECURITY_CONFIG_FILE)) {
    sec = JSON.parse(fs.readFileSync(SECURITY_CONFIG_FILE, 'utf8'));
  }
  sec.collector_ftp_servers = servers;
  writeJsonAtomic(SECURITY_CONFIG_FILE, sec);
}

// 视频网采集端：多 FTP 服务器节点 CRUD REST API
app.get('/api/ftp/servers', (req, res) => {
  const servers = getCollectorFtpServers();
  const safeServers = servers.map(s => ({
    ...s,
    ftp_password: s.ftp_password ? '********' : ''
  }));
  res.json({ success: true, data: safeServers });
});

app.post('/api/ftp/servers', requireRole('admin'), (req, res) => {
  try {
    const { name, ftp_host, ftp_port, ftp_user, ftp_password, ftp_remote_dir, pkg_prefix, ftp_file_ext, ftp_enabled } = req.body;
    if (!ftp_host || !ftp_host.trim()) {
      return res.status(400).json({ success: false, error: 'FTP 服务器 IP / 域名不能为空' });
    }
    const servers = getCollectorFtpServers();
    const newServer = {
      id: 'ftp_coll_' + Date.now(),
      name: name && name.trim() ? name.trim() : `视频网 FTP_${ftp_host}`,
      ftp_host: ftp_host.trim(),
      ftp_port: parseInt(ftp_port) || 21,
      ftp_user: (ftp_user || '').trim(),
      ftp_password: ftp_password || '',
      ftp_remote_dir: (ftp_remote_dir || '/vfusion_packages').trim(),
      pkg_prefix: (pkg_prefix || 'vfusion_').trim(),
      ftp_file_ext: ftp_file_ext || '.jpg',
      ftp_enabled: ftp_enabled !== false,
      last_push_status: '新注册未推送',
      created_at: new Date().toISOString()
    };
    servers.push(newServer);
    saveCollectorFtpServers(servers);
    addCollectorAuditLog('FTP_CONFIG', `视频网端注册新增 FTP 服务器节点 [${newServer.name} - ${newServer.ftp_host}:${newServer.ftp_port}]`, 'SUCCESS');
    res.json({ success: true, message: 'FTP 节点注册添加成功', data: { ...newServer, ftp_password: newServer.ftp_password ? '********' : '' } });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.put('/api/ftp/servers/:id', requireRole('admin'), (req, res) => {
  try {
    const { id } = req.params;
    const servers = getCollectorFtpServers();
    const idx = servers.findIndex(s => String(s.id) === String(id));
    if (idx === -1) return res.status(404).json({ success: false, error: '未找到指定的 FTP 节点' });

    const target = servers[idx];
    const { name, ftp_host, ftp_port, ftp_user, ftp_password, ftp_remote_dir, pkg_prefix, ftp_file_ext, ftp_enabled } = req.body;

    if (name !== undefined) target.name = name;
    if (ftp_host !== undefined) target.ftp_host = ftp_host;
    if (ftp_port !== undefined) target.ftp_port = parseInt(ftp_port) || 21;
    if (ftp_user !== undefined) target.ftp_user = ftp_user;
    if (ftp_password !== undefined && ftp_password !== '********') target.ftp_password = ftp_password;
    if (ftp_remote_dir !== undefined) target.ftp_remote_dir = ftp_remote_dir;
    if (pkg_prefix !== undefined) target.pkg_prefix = pkg_prefix;
    if (ftp_file_ext !== undefined) target.ftp_file_ext = ftp_file_ext;
    if (ftp_enabled !== undefined) target.ftp_enabled = ftp_enabled;

    saveCollectorFtpServers(servers);
    addCollectorAuditLog('FTP_CONFIG', `视频网端更新 FTP 服务器节点配置 [${target.name}]`, 'SUCCESS');
    res.json({ success: true, message: 'FTP 节点配置更新成功' });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.patch('/api/ftp/servers/:id/toggle', requireRole('admin'), (req, res) => {
  try {
    const { id } = req.params;
    const { enabled } = req.body;
    const servers = getCollectorFtpServers();
    const target = servers.find(s => String(s.id) === String(id));
    if (!target) return res.status(404).json({ success: false, error: '未找到指定的 FTP 节点' });

    target.ftp_enabled = !!enabled;
    saveCollectorFtpServers(servers);
    addCollectorAuditLog('FTP_CONFIG', `视频网端 ${enabled ? '开启' : '关闭'} FTP 通道节点 [${target.name}]`, 'SUCCESS');
    res.json({ success: true, message: `FTP 通道节点已${enabled ? '开启' : '关闭'}` });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.delete('/api/ftp/servers/:id', requireRole('admin'), (req, res) => {
  try {
    const { id } = req.params;
    let servers = getCollectorFtpServers();
    const target = servers.find(s => String(s.id) === String(id));
    servers = servers.filter(s => String(s.id) !== String(id));
    saveCollectorFtpServers(servers);
    addCollectorAuditLog('FTP_CONFIG', `视频网端移除 FTP 通道节点 [${target ? target.name : id}]`, 'SUCCESS');
    res.json({ success: true, message: 'FTP 节点已移除' });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/ftp/servers/:id/test', requireRole('admin'), async (req, res) => {
  try {
    const { id } = req.params;
    const servers = getCollectorFtpServers();
    let config;
    if (id === 'new') {
      config = { ...req.body };
    } else {
      const target = servers.find(s => String(s.id) === String(id));
      if (!target) return res.status(404).json({ success: false, error: '未找到指定的 FTP 节点' });
      config = { ...target, ...req.body };
      if (!config.ftp_password || config.ftp_password === '********') {
        config.ftp_password = target.ftp_password || '';
      }
    }
    const testResult = await testFtpConnection(config);
    addCollectorAuditLog('FTP_TEST', `视频网端测试 FTP 节点 [${config.name || config.ftp_host}] 连通性成功`, 'SUCCESS');
    res.json(testResult);
  } catch (err) {
    addCollectorAuditLog('FTP_TEST', `视频网端测试 FTP 连通性失败: ${err.message}`, 'WARN');
    res.status(400).json({ success: false, error: err.message });
  }
});

// 视频网采集端：获取与保存 FTP 与 HMAC 配置 API
app.get('/api/config/ftp', (req, res) => {
  try {
    if (fs.existsSync(SECURITY_CONFIG_FILE)) {
      const sec = JSON.parse(fs.readFileSync(SECURITY_CONFIG_FILE, 'utf8'));
      return res.json({
        success: true,
        data: {
          ftp_enabled: sec.ftp_enabled || false,
          ftp_host: sec.ftp_host || '',
          ftp_port: sec.ftp_port || 21,
          ftp_user: sec.ftp_user || '',
          ftp_password: sec.ftp_password ? '********' : '',
          ftp_remote_dir: sec.ftp_remote_dir || '/vfusion_packages',
          pkg_prefix: sec.pkg_prefix || 'vfusion_',
          ftp_file_ext: sec.ftp_file_ext || '.jpg',
          hmac_secret: '',
          hmac_secret_masked: maskSecret(sec.hmac_secret)
        }
      });
    }
  } catch (e) {}
  res.json({
    success: true,
    data: { ftp_enabled: false, ftp_host: '', ftp_port: 21, ftp_user: '', ftp_password: '', ftp_remote_dir: '/vfusion_packages', pkg_prefix: 'vfusion_', ftp_file_ext: '.jpg', hmac_secret: '', hmac_secret_masked: '' }
  });
});

app.post('/api/config/ftp', requireRole('admin'), (req, res) => {
  try {
    let sec = {};
    if (fs.existsSync(SECURITY_CONFIG_FILE)) {
      sec = JSON.parse(fs.readFileSync(SECURITY_CONFIG_FILE, 'utf8'));
    }
    const { ftp_enabled, ftp_host, ftp_port, ftp_user, ftp_password, ftp_remote_dir, pkg_prefix, ftp_file_ext, hmac_secret } = req.body;
    if (typeof ftp_enabled === 'boolean') sec.ftp_enabled = ftp_enabled;
    if (typeof ftp_host === 'string') sec.ftp_host = ftp_host;
    if (typeof ftp_port === 'number' || typeof ftp_port === 'string') sec.ftp_port = parseInt(ftp_port) || 21;
    if (typeof ftp_user === 'string') sec.ftp_user = ftp_user;
    if (typeof ftp_password === 'string' && ftp_password && ftp_password !== '********') {
      sec.ftp_password = ftp_password;
    }
    if (typeof ftp_remote_dir === 'string') sec.ftp_remote_dir = ftp_remote_dir;
    if (typeof pkg_prefix === 'string') sec.pkg_prefix = pkg_prefix;
    if (typeof ftp_file_ext === 'string') sec.ftp_file_ext = ftp_file_ext;

    if (hmac_secret !== undefined && (typeof hmac_secret !== 'string' || hmac_secret.trim().length < 32 || hmac_secret.trim().length > 256)) {
      return res.status(400).json({ success: false, error: 'HMAC 密钥长度必须为 32-256 个字符' });
    }
    if (typeof hmac_secret === 'string' && hmac_secret.trim().length > 0) {
      sec.hmac_secret = hmac_secret.trim();
      setHmacSecret(sec.hmac_secret);
    }

    writeJsonAtomic(SECURITY_CONFIG_FILE, sec);
    addCollectorAuditLog('FTP_CONFIG', `视频网端更新传输与 HMAC 签名配置 (Host: ${sec.ftp_host || '无'}:${sec.ftp_port || 21})`, 'SUCCESS');
    res.json({ success: true, message: '视频网端配置与 HMAC 签名秘钥保存成功' });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/config/ftp/test', requireRole('admin'), async (req, res) => {
  try {
    const config = { ...req.body };
    // 前端回传的是掩码时，改用已保存的真实口令进行连通性测试
    if (!config.ftp_password || config.ftp_password === '********') {
      const sec = loadSecurityConfig();
      config.ftp_password = (sec && sec.ftp_password) || '';
    }
    const testResult = await testFtpConnection(config);
    addCollectorAuditLog('FTP_TEST', `视频网端测试 FTP 连接 [${config.ftp_host}:${config.ftp_port}] 成功`, 'SUCCESS');
    res.json(testResult);
  } catch (err) {
    addCollectorAuditLog('FTP_TEST', `视频网端测试 FTP 连接失败: ${err.message}`, 'WARN');
    res.status(400).json({ success: false, error: err.message });
  }
});

// 视频网采集端：Web 控制台一键无损热升级 API
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
      addCollectorAuditLog('SYSTEM_UPGRADE', `管理员在 Web 控制台上传热升级补丁包成功`, 'SUCCESS');
      res.json(result);
    } catch (e) {
      addCollectorAuditLog('SYSTEM_UPGRADE', `热升级补丁包更新失败: ${e.message}`, 'WARN');
      res.status(500).json({ success: false, error: e.message });
    }
  });
});

// 视频网端：获取本人/本终端历史已发布提交记录 API
app.get('/api/published-history', async (req, res) => {
  try {
    const events = await collectorSqlite.getEvents();
    res.json({ success: true, data: events });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

const os = require('os');
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
  console.log(` 视频网数据采集/发布终端 (VFusion Collector v0.19.0) 已启动`);
  console.log(` 本机访问地址: http://localhost:${PORT}`);
  localIps.forEach(ip => {
    console.log(` 局域网/其他电脑访问地址: http://${ip}:${PORT}`);
  });
  console.log(`===================================================`);
});

let shuttingDown = false;
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[VFusion Collector] 收到 ${signal}，正在优雅关闭...`);
  await new Promise(resolve => httpServer.close(() => resolve()));
  try { await collectorSqlite.close(); } catch (e) { console.error('[VFusion Collector] 关闭数据库失败:', e.message); }
}
process.once('SIGINT', () => gracefulShutdown('SIGINT').finally(() => process.exit(0)));
process.once('SIGTERM', () => gracefulShutdown('SIGTERM').finally(() => process.exit(0)));
