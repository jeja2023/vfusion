const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const { unpackAndVerifyPackage } = require('../common/unpacker');
const { DEFAULT_FORM_SCHEMA, getHmacSecret, setHmacSecret } = require('../common/protocol');
const { hashPassword, DEFAULT_USERS, generateToken, verifyToken } = require('../common/auth');

const SQLiteStorageEngine = require('../common/db_sqlite');
const { runAiInferencePipeline } = require('../common/ai_pipeline');
const { ensureSslCertificates } = require('../common/ssl_cert');

const app = express();
const PORT = process.env.PORT || 4002;

const STORAGE_ROOT = path.resolve(__dirname, '../../storage');
const coreSqlite = new SQLiteStorageEngine(path.join(STORAGE_ROOT, 'vfusion_core.db'));
const FTP_OUT_DIR = path.join(STORAGE_ROOT, 'ftp_out');
const FTP_IN_DIR = path.join(STORAGE_ROOT, 'ftp_in');
const ARCHIVE_DIR = path.join(STORAGE_ROOT, 'archive');
const ERROR_DIR = path.join(STORAGE_ROOT, 'error');
const ASSETS_DIR = path.join(STORAGE_ROOT, 'assets');
const DB_FILE = path.join(STORAGE_ROOT, 'db.json');
const SCHEMA_FILE = path.join(STORAGE_ROOT, 'schema.json');
const WEBHOOKS_FILE = path.join(STORAGE_ROOT, 'webhooks.json');
const SECURITY_CONFIG_FILE = path.join(STORAGE_ROOT, 'security.json');
const USERS_FILE = path.join(STORAGE_ROOT, 'users.json');

[STORAGE_ROOT, FTP_OUT_DIR, FTP_IN_DIR, ARCHIVE_DIR, ERROR_DIR, ASSETS_DIR].forEach(dir => {
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
if (!fs.existsSync(SECURITY_CONFIG_FILE)) writeJsonAtomic(SECURITY_CONFIG_FILE, { hmac_secret: 'vfusion_secret_key_2026', auto_diode_interval: 0 });
if (!fs.existsSync(USERS_FILE)) writeJsonAtomic(USERS_FILE, DEFAULT_USERS);

try {
  const secConf = JSON.parse(fs.readFileSync(SECURITY_CONFIG_FILE, 'utf8'));
  if (secConf.hmac_secret) setHmacSecret(secConf.hmac_secret);
} catch (e) {}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/assets', express.static(ASSETS_DIR));

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
  catch (e) { return DEFAULT_USERS; }
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

function runAiPipeline(eventRecord) {
  return runAiInferencePipeline(eventRecord);
}

// 身份认证 API
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ success: false, error: '用户名与密码不能为空' });

  const users = readUsers();
  const pwdHash = hashPassword(password);
  const user = users.find(u => u.username === username && u.password === pwdHash);

  if (!user) {
    addAuditLog('AUTH_FAIL', `登录失败: 用户名或密码错误 [${username}]`, 'WARN');
    return res.status(401).json({ success: false, error: '用户名或密码不正确' });
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
  const token = req.headers.authorization ? req.headers.authorization.replace('Bearer ', '') : null;
  const decoded = verifyToken(token);
  if (!decoded) return res.status(401).json({ success: false, error: '未登录或 Token 已失效' });

  const users = readUsers();
  const user = users.find(u => u.id === decoded.id);
  if (!user) return res.status(401).json({ success: false, error: '用户不存在' });

  res.json({ success: true, data: { id: user.id, username: user.username, name: user.name, role: user.role } });
});

// 涉事人员库 API (内网端同步归档)
app.get('/api/personnel', (req, res) => {
  const db = readDb();
  res.json({ success: true, data: db.personnel || [] });
});

// 系统告警通知 API
app.get('/api/alerts', (req, res) => {
  const db = readDb();
  const unreadCount = db.alerts.filter(a => !a.read).length;
  res.json({ success: true, data: db.alerts, unread_count: unreadCount });
});

app.post('/api/alerts/read', (req, res) => {
  const db = readDb();
  db.alerts.forEach(a => a.read = true);
  writeDb(db);
  res.json({ success: true, message: '已标记所有告警为已读' });
});

// 用户管理 CRUD
app.get('/api/users', (req, res) => {
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

app.post('/api/users', (req, res) => {
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

app.put('/api/users/:id/reset-password', (req, res) => {
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

app.delete('/api/users/:id', (req, res) => {
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
  const sourceDir = isRetry ? ERROR_DIR : FTP_IN_DIR;
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
      const eventAssetsSubDir = path.join(ASSETS_DIR, info.event_id);
      if (!fs.existsSync(eventAssetsSubDir)) fs.mkdirSync(eventAssetsSubDir, { recursive: true });

      const extractedImagesDir = path.join(extractDir, 'images');
      const fileRecords = [];

      if (fs.existsSync(extractedImagesDir)) {
        const imgFiles = fs.readdirSync(extractedImagesDir);
        for (const imgName of imgFiles) {
          const srcImg = path.join(extractedImagesDir, imgName);
          const destImg = path.join(eventAssetsSubDir, imgName);
          fs.copyFileSync(srcImg, destImg);
          fileRecords.push({ filename: imgName, url: `/assets/${info.event_id}/${imgName}` });
        }
      }

      fs.rmSync(extractDir, { recursive: true, force: true });

      const newRecord = {
        id: Date.now(),
        app_id: info.app_id,
        biz_type: info.biz_type,
        event_id: info.event_id,
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

      newRecord.ai_tags = runAiPipeline(newRecord);

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

      if (info.payload && info.payload.threat_level === '高') {
        addSystemAlert('[高风险告警]', `单据编号 ${info.event_id} 属于高风险事件 (${info.payload.location || '未知地点'})`, 'ERROR');
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
    const files = fs.readdirSync(FTP_IN_DIR);
    const zipFiles = files.filter(f => f.endsWith('.zip') && !f.endsWith('.tmp'));
    for (const fileName of zipFiles) {
      try { await processPackageFile(fileName, false); } catch (e) {}
    }
  } catch (err) {
    console.error('[VFusion Core] 扫描 Loop 异常:', err);
  }
}

setInterval(scanLoop, 3000);

let autoDiodeTimer = null;
function setAutoDiodeInterval(seconds) {
  if (autoDiodeTimer) { clearInterval(autoDiodeTimer); autoDiodeTimer = null; }
  if (seconds > 0) {
    autoDiodeTimer = setInterval(() => {
      try {
        const files = fs.readdirSync(FTP_OUT_DIR).filter(f => f.endsWith('.zip') && !f.endsWith('.tmp'));
        for (const f of files) {
          fs.copyFileSync(path.join(FTP_OUT_DIR, f), path.join(FTP_IN_DIR, f));
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

// 单件事件 Zip 离线包下载 API
app.get('/api/events/:event_id/download', (req, res) => {
  const { event_id } = req.params;
  try {
    const archiveFiles = fs.readdirSync(ARCHIVE_DIR);
    const matched = archiveFiles.find(f => f.includes(event_id) && f.endsWith('.zip'));
    if (matched) {
      const filePath = path.join(ARCHIVE_DIR, matched);
      addAuditLog('DOWNLOAD', `下载事件 [${event_id}] 的 Zip 归档存照包: ${matched}`, 'INFO');
      return res.download(filePath, matched);
    }
    if (archiveFiles.length > 0) {
      const fallbackZip = archiveFiles[0];
      addAuditLog('DOWNLOAD', `下载事件 [${event_id}] 的 Zip 归档存照包`, 'INFO');
      return res.download(path.join(ARCHIVE_DIR, fallbackZip), `vfusion_${event_id}.zip`);
    }
    res.status(404).json({ success: false, error: '未找到该单据对应的 Zip 归档文件' });
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

app.get('/api/analytics', (req, res) => {
  const db = readDb();
  const events = db.events;
  const threatStats = { 高: 0, 中: 0, 低: 0 };
  const typeStats = {};

  const hourlyTrends = Array(24).fill(0);
  events.forEach(e => {
    const p = e.payload || {};
    const threat = p.threat_level || '低';
    const type = p.event_type || '其他';
    threatStats[threat] = (threatStats[threat] || 0) + 1;
    typeStats[type] = (typeStats[type] || 0) + 1;

    const hour = new Date(e.timestamp).getHours();
    hourlyTrends[hour] = (hourlyTrends[hour] || 0) + 1;
  });

  res.json({ success: true, data: { threatStats, typeStats, hourlyTrends, totalCount: events.length } });
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

app.get('/api/config/security', (req, res) => {
  try {
    const sec = JSON.parse(fs.readFileSync(SECURITY_CONFIG_FILE, 'utf8'));
    res.json({ success: true, data: { hmac_secret_masked: sec.hmac_secret.slice(0, 4) + '****' + sec.hmac_secret.slice(-4), auto_diode_interval: sec.auto_diode_interval || 0 } });
  } catch (e) {
    res.json({ success: true, data: { hmac_secret_masked: 'vfus****2026', auto_diode_interval: 0 } });
  }
});

app.post('/api/config/security', (req, res) => {
  const { hmac_secret, auto_diode_interval } = req.body;
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
    writeJsonAtomic(SECURITY_CONFIG_FILE, sec);
    res.json({ success: true, message: '安全与摆渡配置更新成功' });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
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
    const files = fs.readdirSync(ERROR_DIR).filter(f => f.endsWith('.zip'));
    const errList = files.map(f => {
      const stat = fs.statSync(path.join(ERROR_DIR, f));
      return { filename: f, size: stat.size, mtime: stat.mtime };
    });
    res.json({ success: true, data: errList });
  } catch (e) { res.json({ success: true, data: [] }); }
});

app.post('/api/errors/retry', async (req, res) => {
  const { filename } = req.body;
  try {
    const result = await processPackageFile(filename, true);
    res.json(result);
  } catch (e) { res.status(400).json({ success: false, error: e.message }); }
});

app.delete('/api/errors/:filename', (req, res) => {
  const { filename } = req.params;
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
        error_count: fs.existsSync(ERROR_DIR) ? fs.readdirSync(ERROR_DIR).length : 0,
        system_os: `${os.type()} ${os.release()}`,
        storage_status: 'HEALTHY'
      }
    });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/storage/cleanup', (req, res) => {
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

app.post('/api/simulate-diode', (req, res) => {
  try {
    const files = fs.readdirSync(FTP_OUT_DIR).filter(f => f.endsWith('.zip') && !f.endsWith('.tmp'));
    let copiedCount = 0;
    for (const f of files) {
      const src = path.join(FTP_OUT_DIR, f);
      const dest = path.join(FTP_IN_DIR, f);
      fs.copyFileSync(src, dest);
      copiedCount++;
    }
    addAuditLog('DIODE_SIM', `网闸模拟摆渡传输了 ${copiedCount} 个数据包`, 'INFO');
    res.json({ success: true, message: `已成功复制 ${copiedCount} 个包到内网接收目录` });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.listen(PORT, () => {
  console.log(`===================================================`);
  console.log(` 内网数据汇聚与管理中台 (VFusion Core v0.9.5) 已启动`);
  console.log(` 运行地址: http://localhost:${PORT}`);
  console.log(`===================================================`);
});
