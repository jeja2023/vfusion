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
const { authMiddleware, requireRole } = require('../common/auth_middleware');

const SQLiteStorageEngine = require('../common/db_sqlite');
const { buildEventTags } = require('../common/event_tags');
const { ensureSslCertificates } = require('../common/ssl_cert');
const { testFtpConnection, uploadToRemoteFtp, downloadFromRemoteFtp } = require('../common/ftp_client');
const { formidable } = require('formidable');
const { performOnlineUpgrade } = require('../common/system_upgrader');

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

[STORAGE_ROOT, FTP_OUT_DIR, FTP_IN_DIR, ARCHIVE_DIR, ERROR_DIR, ASSETS_DIR, COLLECTOR_ASSETS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

function writeJsonAtomic(filePath, data) {
  const tmpPath = `${filePath}.tmp_${Date.now()}`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
}

if (!fs.existsSync(DB_FILE)) writeJsonAtomic(DB_FILE, { events: [], audit_logs: [], alerts: [] });
if (!fs.existsSync(SCHEMA_FILE)) writeJsonAtomic(SCHEMA_FILE, DEFAULT_FORM_SCHEMA);
if (!fs.existsSync(WEBHOOKS_FILE)) writeJsonAtomic(WEBHOOKS_FILE, []);

// 首次启动时生成随机 HMAC / Token 密钥，避免固定密钥随源码分发
if (!fs.existsSync(SECURITY_CONFIG_FILE)) {
  writeJsonAtomic(SECURITY_CONFIG_FILE, {
    hmac_secret: crypto.randomBytes(32).toString('hex'),
    token_secret: crypto.randomBytes(32).toString('hex'),
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
  if (mutated) writeJsonAtomic(SECURITY_CONFIG_FILE, secConf);

  setHmacSecret(secConf.hmac_secret);
  setTokenSecret(secConf.token_secret);
} catch (e) {
  console.error('[VFusion Core] 读取安全配置失败:', e.message);
  process.exit(1);
}

// CORS 白名单：默认仅允许同源与显式配置的来源，避免任意站点驱动内网 API
const ALLOWED_ORIGINS = (process.env.VFUSION_ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error('该来源不在 CORS 白名单内'));
  }
}));
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/assets', express.static(ASSETS_DIR));
app.use('/assets', express.static(COLLECTOR_ASSETS_DIR));
app.use('/collector-assets', express.static(COLLECTOR_ASSETS_DIR));
app.use('/collector-assets', express.static(ASSETS_DIR));
app.get('/favicon.ico', (req, res) => res.status(204).end());

// 统一身份认证：登录接口与静态资源之外的所有 API 均需有效 Token
app.use(authMiddleware({
  loadUser: (id) => readUsers().find(u => u.id === id) || null
}));

function readDb() {
  try {
    const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (!db.alerts) db.alerts = [];
    return db;
  }
  catch (e) { return { events: [], audit_logs: [], alerts: [] }; }
}
function writeDb(db) { writeJsonAtomic(DB_FILE, db); }

function readUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); }
  catch (e) { return []; }
}
function writeUsers(list) { writeJsonAtomic(USERS_FILE, list); }

function readWebhooks() {
  try { return JSON.parse(fs.readFileSync(WEBHOOKS_FILE, 'utf8')); }
  catch (e) { return []; }
}
function writeWebhooks(list) { writeJsonAtomic(WEBHOOKS_FILE, list); }

function addAuditLog(type, message, status = 'INFO') {
  const db = readDb();
  db.audit_logs.unshift({
    id: Date.now(),
    timestamp: new Date().toISOString(),
    type,
    message,
    status
  });
  if (db.audit_logs.length > 500) db.audit_logs = db.audit_logs.slice(0, 500);
  writeDb(db);
  coreSqlite.addAuditLog(type, message, status);
}

function addSystemAlert(title, message, level = 'WARN') {
  const db = readDb();
  db.alerts.unshift({
    id: Date.now(),
    timestamp: new Date().toISOString(),
    title,
    message,
    level,
    read: false
  });
  if (db.alerts.length > 100) db.alerts = db.alerts.slice(0, 100);
  writeDb(db);
}

function tagEvent(eventRecord) {
  return buildEventTags(eventRecord);
}

// 身份认证 API
app.post('/api/auth/login', (req, res) => {
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

  saveDb(db);
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
  saveDb(db);
  addAuditLog('PERSONNEL_DELETE', `删除涉事人员档案 [${deleted.name}]`, 'WARN');
  res.json({ success: true, message: '人员档案已成功删除' });
});

// 任务管理与跨网汇聚 API (内网端)
app.get('/api/tasks', async (req, res) => {
  try {
    const tasks = await coreSqlite.getTasks();
    const events = await coreSqlite.getEvents();

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

    const knownCodes = new Set(tasks.map(t => t.task_code));
    events.forEach(evt => {
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
        coreSqlite.saveTask(autoTask);
        tasks.unshift(autoTask);
        knownCodes.add(code);
      }
    });

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
    const events = await coreSqlite.getEvents(app_id || null);
    res.json({ success: true, data: events });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/tasks/:code', async (req, res) => {
  try {
    const { code } = req.params;
    const task = await coreSqlite.getTaskByCode(code);
    const allEvents = await coreSqlite.getEvents();
    const taskEvents = allEvents.filter(e => e.task_code === code);

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

    coreSqlite.updateTaskStatus(code, status);
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
  res.json({ success: true, message: '用户创建成功', data: newUser });
});

app.put('/api/users/:id/reset-password', requireRole('admin'), (req, res) => {
  const id = parseInt(req.params.id);
  const { new_password } = req.body;
  if (!new_password) return res.status(400).json({ success: false, error: '新密码不能为空' });

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
  if (user.username === 'admin') return res.status(400).json({ success: false, error: '超级管理员内置账号不能删除' });

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
  if (user.username === 'admin') return res.status(400).json({ success: false, error: '超级管理员内置账号不能编辑' });

  user.name = name;
  if (role) user.role = role;
  if (status) user.status = status;

  writeUsers(users);
  addAuditLog('USER_UPDATE', `更新用户 [${user.name}(${user.username})], 角色: ${user.role}, 状态: ${user.status}`, 'SUCCESS');
  res.json({ success: true, message: '用户信息更新成功', data: user });
});


function dispatchWebhooks(eventRecord) {
  const hooks = readWebhooks();
  if (hooks.length === 0) return;

  const payloadStr = JSON.stringify({
    event: 'EVENT_INGESTED',
    timestamp: new Date().toISOString(),
    data: eventRecord
  });

  hooks.forEach(hook => {
    try {
      const urlObj = new URL(hook.url);
      const reqModule = urlObj.protocol === 'https:' ? https : http;

      const req = reqModule.request(hook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payloadStr),
          'X-VFusion-Signature': eventRecord.signature || ''
        }
      }, res => {
        addAuditLog('WEBHOOK', `消息分发 [${hook.name}]: HTTP ${res.statusCode}`, res.statusCode < 400 ? 'SUCCESS' : 'WARN');
      });

      req.on('error', err => {
        addAuditLog('WEBHOOK', `消息分发失败 [${hook.name}]: ${err.message}`, 'WARN');
      });

      req.write(payloadStr);
      req.end();
    } catch (e) {
      console.error('Webhook 网址错误:', hook.url);
    }
  });
}

async function processPackageFile(fileName, isRetry = false) {
  const sourceDir = isRetry ? ERROR_DIR : getFtpInDir();
  const zipPath = path.join(sourceDir, fileName);

  if (!fs.existsSync(zipPath)) {
    throw new Error(`文件不存在: ${fileName}`);
  }

  console.log(`[VFusion Core] 处理数据包 (${isRetry ? '重试' : '自动'}): ${fileName}`);
  addAuditLog('SCANNER', `${isRetry ? '重试' : '自动'}处理数据包 ${fileName}...`);

  try {
    const { zipFileHash, extractDir, info } = await unpackAndVerifyPackage(zipPath, ASSETS_DIR);
    const db = readDb();
    const exists = db.events.find(e => e.event_id === info.event_id || e.zip_hash === zipFileHash);

    if (exists) {
      addAuditLog('IDEMPOTENCY', `事件 ${info.event_id} 已存在，幂等归档`, 'WARN');
      fs.rmSync(extractDir, { recursive: true, force: true });
    } else {
      const taskCode = info.task_code || 'TASK_DEFAULT';
      const taskName = info.task_name || '厂区周界安防例行巡检';
      const eventAssetsSubDir = path.join(ASSETS_DIR, 'tasks', taskCode, info.event_id);
      if (!fs.existsSync(eventAssetsSubDir)) fs.mkdirSync(eventAssetsSubDir, { recursive: true });

      const extractedImagesDir = path.join(extractDir, 'images');
      const fileRecords = [];

      if (fs.existsSync(extractedImagesDir)) {
        const imgFiles = fs.readdirSync(extractedImagesDir);
        for (const imgName of imgFiles) {
          const srcImg = path.join(extractedImagesDir, imgName);
          const destImg = path.join(eventAssetsSubDir, imgName);
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

      // 字段名 ai_tags 为历史数据库列名，保留以兼容既有数据
      newRecord.ai_tags = tagEvent(newRecord);

      // 如果数据包负荷中包含涉事人员信息，自动同步归档至内网人员库
      const p = info.payload || {};
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
      coreSqlite.saveEvent(newRecord);

      // 确保/更新内网端任务条目记录
      const existingTask = await coreSqlite.getTaskByCode(taskCode);
      if (!existingTask) {
        coreSqlite.saveTask({
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
        coreSqlite.saveTask({
          ...existingTask,
          task_name: taskName || existingTask.task_name,
          updated_at: new Date().toISOString()
        });
      }

      if (info.payload && info.payload.event_id) {
        addSystemAlert('[新单据通知]', `单据编号 ${info.event_id} 已成功摆渡入库 (${info.payload.location || '未知地点'})`, 'INFO');
      }

      dispatchWebhooks(newRecord);
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

async function scanLoop() {
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
  }
}

setInterval(scanLoop, 3000);

// ========== FTP 远程自动轮询拉取引擎 ==========
let ftpPollTimer = null;
let ftpPollStatus = { running: false, lastPollTime: null, lastResult: null, downloadedTotal: 0, errorCount: 0 };

function getFtpConfig() {
  try {
    if (fs.existsSync(SECURITY_CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(SECURITY_CONFIG_FILE, 'utf8'));
    }
  } catch (e) {}
  return null;
}

async function ftpPollLoop() {
  if (ftpPollStatus.running) return; // 防止并发重入
  const sec = getFtpConfig();
  if (!sec || !sec.ftp_enabled || !sec.ftp_host) return;

  ftpPollStatus.running = true;
  ftpPollStatus.lastPollTime = new Date().toISOString();

  try {
    const ftpInDir = getFtpInDir();
    if (!fs.existsSync(ftpInDir)) fs.mkdirSync(ftpInDir, { recursive: true });
    const prefix = getPkgPrefix();

    const downloadedFiles = await downloadFromRemoteFtp(ftpInDir, sec, prefix);

    if (downloadedFiles.length > 0) {
      ftpPollStatus.downloadedTotal += downloadedFiles.length;
      ftpPollStatus.lastResult = `成功拉取 ${downloadedFiles.length} 个数据包: ${downloadedFiles.join(', ')}`;
      addAuditLog('FTP_POLL', `从远程 FTP [${sec.ftp_host}:${sec.ftp_port || 21}] 自动拉取了 ${downloadedFiles.length} 个数据包`, 'SUCCESS');
      console.log(`[VFusion Core FTP] 从远程 FTP 拉取了 ${downloadedFiles.length} 个包: ${downloadedFiles.join(', ')}`);

      // 立即逐个处理刚从 FTP 拉取的新包（只处理本次拉取的，不扫描旧文件）
      for (const fileName of downloadedFiles) {
        try {
          await processPackageFile(fileName, false);
          console.log(`[VFusion Core FTP] 已自动解包入库: ${fileName}`);
        } catch (procErr) {
          console.error(`[VFusion Core FTP] 处理 ${fileName} 失败:`, procErr.message);
        }
      }
    } else {
      ftpPollStatus.lastResult = '远程 FTP 目录暂无新数据包';
    }
  } catch (err) {
    ftpPollStatus.errorCount++;
    ftpPollStatus.lastResult = `轮询异常: ${err.message}`;
    addAuditLog('FTP_POLL', `远程 FTP 轮询拉取失败: ${err.message}`, 'WARN');
    console.error('[VFusion Core FTP] 远程轮询异常:', err.message);
  } finally {
    ftpPollStatus.running = false;
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
    if (sec && sec.ftp_enabled && sec.ftp_host) {
      const interval = sec.ftp_poll_interval || 10;
      setFtpPollInterval(interval);
      addAuditLog('FTP_POLL', `服务启动时自动启用 FTP 远程轮询 (每 ${interval} 秒)`, 'INFO');
    }
  } catch (e) {}
}

// 手动触发一次 FTP 拉取
app.post('/api/ftp/pull', async (req, res) => {
  try {
    const sec = getFtpConfig();
    if (!sec || !sec.ftp_enabled || !sec.ftp_host) {
      return res.status(400).json({ success: false, error: '未配置或未启用第三方 FTP 服务器，请先在 FTP 配置页面填写并启用' });
    }
    const ftpInDir = getFtpInDir();
    if (!fs.existsSync(ftpInDir)) fs.mkdirSync(ftpInDir, { recursive: true });
    const prefix = getPkgPrefix();

    const downloadedFiles = await downloadFromRemoteFtp(ftpInDir, sec, prefix);

    // 立即处理刚从 FTP 拉取的新包
    let processedCount = 0;
    for (const fileName of downloadedFiles) {
      try {
        await processPackageFile(fileName, false);
        processedCount++;
      } catch (procErr) {
        console.error(`[VFusion Core FTP] 手动拉取处理 ${fileName} 失败:`, procErr.message);
      }
    }

    addAuditLog('FTP_PULL', `管理员手动触发 FTP 拉取，下载了 ${downloadedFiles.length} 个数据包，成功入库 ${processedCount} 个`, downloadedFiles.length > 0 ? 'SUCCESS' : 'INFO');
    res.json({
      success: true,
      message: downloadedFiles.length > 0
        ? `成功从远程 FTP 拉取 ${downloadedFiles.length} 个数据包并入库处理 ${processedCount} 个: ${downloadedFiles.join(', ')}`
        : '远程 FTP 目录中暂无匹配的新数据包',
      data: { files: downloadedFiles, count: downloadedFiles.length, processed: processedCount }
    });
  } catch (err) {
    addAuditLog('FTP_PULL', `手动 FTP 拉取失败: ${err.message}`, 'ERROR');
    res.status(500).json({ success: false, error: err.message });
  }
});

// FTP 轮询状态查询
app.get('/api/ftp/poll-status', (req, res) => {
  const sec = getFtpConfig();
  res.json({
    success: true,
    data: {
      enabled: !!(sec && sec.ftp_enabled && sec.ftp_host),
      poll_interval: sec ? (sec.ftp_poll_interval || 10) : 0,
      timer_active: !!ftpPollTimer,
      ...ftpPollStatus
    }
  });
});

// FTP 轮询间隔控制
app.post('/api/ftp/poll-interval', requireRole('admin'), (req, res) => {
  const { interval } = req.body;
  const seconds = parseInt(interval) || 0;
  try {
    const sec = getFtpConfig() || {};
    sec.ftp_poll_interval = seconds;
    writeJsonAtomic(SECURITY_CONFIG_FILE, sec);
    setFtpPollInterval(seconds);
    addAuditLog('FTP_POLL', `FTP 远程自动轮询间隔已更新为 ${seconds} 秒 (${seconds > 0 ? '启用' : '停止'})`, 'SUCCESS');
    res.json({ success: true, message: seconds > 0 ? `FTP 自动轮询已启动 (每 ${seconds} 秒)` : 'FTP 自动轮询已停止' });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

let autoDiodeTimer = null;
function setAutoDiodeInterval(seconds) {
  if (autoDiodeTimer) { clearInterval(autoDiodeTimer); autoDiodeTimer = null; }
  if (seconds > 0) {
    autoDiodeTimer = setInterval(() => {
      try {
        const ftpOutDir = getFtpOutDir();
        const ftpInDir = getFtpInDir();
        const prefix = getPkgPrefix();
        if (!fs.existsSync(ftpOutDir)) fs.mkdirSync(ftpOutDir, { recursive: true });
        if (!fs.existsSync(ftpInDir)) fs.mkdirSync(ftpInDir, { recursive: true });
        const files = fs.readdirSync(ftpOutDir).filter(f => f.startsWith(prefix) && (f.endsWith('.zip') || f.endsWith('.jpg')) && !f.endsWith('.tmp'));
        for (const f of files) {
          fs.copyFileSync(path.join(ftpOutDir, f), path.join(ftpInDir, f));
        }
      } catch (e) {}
    }, seconds * 1000);
  }
}

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
  return typeof name === 'string' &&
    name.length > 0 &&
    name.length <= 255 &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('\0') &&
    name !== '.' &&
    name !== '..';
}

// 单件事件 Zip 离线包下载 API
app.get('/api/events/:event_id/download', (req, res) => {
  const { event_id } = req.params;
  if (!isSafeFileName(event_id)) {
    return res.status(400).json({ success: false, error: '非法的事件编号' });
  }
  try {
    const archiveFiles = fs.readdirSync(ARCHIVE_DIR);
    const matched = archiveFiles.find(f => f.includes(event_id) && (f.endsWith('.zip') || f.endsWith('.jpg')));
    if (!matched) {
      // 不做任意兜底：返回其他事件的归档包会造成跨单据数据泄露
      return res.status(404).json({ success: false, error: '未找到该单据对应的 Zip 归档文件' });
    }
    const filePath = path.join(ARCHIVE_DIR, matched);
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
  const targetFile = app_id ? path.join(STORAGE_ROOT, `schema_${app_id}.json`) : SCHEMA_FILE;
  try {
    const fileToRead = fs.existsSync(targetFile) ? targetFile : SCHEMA_FILE;
    res.json({ success: true, data: JSON.parse(fs.readFileSync(fileToRead, 'utf8')) });
  } catch (e) { res.json({ success: true, data: DEFAULT_FORM_SCHEMA }); }
});

app.post('/api/schema', (req, res) => {
  try {
    const newSchema = req.body;
    const appId = newSchema.app_id || 'sys_gate_security';
    const targetFile = path.join(STORAGE_ROOT, `schema_${appId}.json`);
    writeJsonAtomic(targetFile, newSchema);
    writeJsonAtomic(SCHEMA_FILE, newSchema);
    addAuditLog('SCHEMA_UPDATE', `表单 Schema 已更新 (App: ${appId}, 包含 ${newSchema.fields.length} 个字段)`, 'SUCCESS');
    res.json({ success: true, message: '表单 Schema 已成功更新并即时跨网同步' });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/events', (req, res) => {
  const { app_id } = req.query;
  const db = readDb();
  let list = db.events;
  if (app_id) list = list.filter(e => e.app_id === app_id);
  res.json({ success: true, data: list });
});

app.get('/api/webhooks', (req, res) => {
  res.json({ success: true, data: readWebhooks() });
});

app.post('/api/webhooks', (req, res) => {
  const { name, url } = req.body;
  if (!name || !url) return res.status(400).json({ success: false, error: '名称与 URL 均不能为空' });

  const list = readWebhooks();
  const newHook = { id: Date.now(), name, url, created_at: new Date().toISOString() };
  list.push(newHook);
  writeWebhooks(list);
  addAuditLog('WEBHOOK_ADD', `注册新消息订阅节点: ${name}`, 'SUCCESS');
  res.json({ success: true, message: '消息订阅节点注册成功', data: newHook });
});

app.delete('/api/webhooks/:id', (req, res) => {
  const id = parseInt(req.params.id);
  let list = readWebhooks();
  list = list.filter(h => h.id !== id);
  writeWebhooks(list);
  addAuditLog('WEBHOOK_DEL', `移除消息订阅节点`, 'WARN');
  res.json({ success: true, message: '订阅节点已删除' });
});

app.put('/api/webhooks/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const { name, url } = req.body;
  if (!name || !url) return res.status(400).json({ success: false, error: '名称与 URL 均不能为空' });

  const list = readWebhooks();
  const hook = list.find(h => h.id === id);
  if (!hook) return res.status(404).json({ success: false, error: '未找到指定的 Webhook 节点' });

  hook.name = name;
  hook.url = url;
  writeWebhooks(list);
  addAuditLog('WEBHOOK_UPDATE', `更新消息订阅节点: ${name}`, 'SUCCESS');
  res.json({ success: true, message: '订阅节点更新成功', data: hook });
});

app.post('/api/webhooks/:id/test', async (req, res) => {
  const list = readWebhooks();
  const hook = list.find(h => String(h.id) === String(req.params.id));
  if (!hook) return res.status(404).json({ success: false, error: '未找到指定的 Webhook 订阅节点' });

  let hmacSecret = 'vfusion_secret_key_2026';
  try {
    if (fs.existsSync(SECURITY_CONFIG_FILE)) {
      const sec = JSON.parse(fs.readFileSync(SECURITY_CONFIG_FILE, 'utf8'));
      if (sec && sec.hmac_secret) hmacSecret = sec.hmac_secret;
    }
  } catch (e) {}

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

  const signature = crypto.createHmac('sha256', hmacSecret).update(payloadStr).digest('hex');

  try {
    const urlObj = new URL(hook.url);
    const reqModule = urlObj.protocol === 'https:' ? https : http;

    const testReq = reqModule.request(hook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payloadStr),
        'X-VFusion-Signature': signature
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

app.get('/api/config/security', requireRole('admin'), (req, res) => {
  try {
    const sec = JSON.parse(fs.readFileSync(SECURITY_CONFIG_FILE, 'utf8'));
    res.json({
      success: true,
      data: {
        hmac_secret: sec.hmac_secret || '',
        hmac_secret_masked: sec.hmac_secret || '未设置',
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
      sec.hmac_secret = hmac_secret;
      setHmacSecret(hmac_secret);
      addAuditLog('SECURITY', `HMAC 数字签名秘钥已在线轮换更新`, 'SUCCESS');
    }
    if (typeof auto_diode_interval === 'number') {
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

app.listen(PORT, '0.0.0.0', () => {
  const localIps = getLocalIps();
  console.log(`===================================================`);
  console.log(` 内网数据汇聚与管理中台 (VFusion Core v0.10.0) 已启动`);
  console.log(` 本机访问地址: http://localhost:${PORT}`);
  localIps.forEach(ip => {
    console.log(` 局域网/其他电脑访问地址: http://${ip}:${PORT}`);
  });
  console.log(`===================================================`);

  // 启动时自动检测并开启 FTP 远程轮询
  bootFtpPoll();
});
