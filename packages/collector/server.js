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
const { authMiddleware, requireRole } = require('../common/auth_middleware');
const { testFtpConnection, uploadToRemoteFtp } = require('../common/ftp_client');

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
  const tmpPath = `${filePath}.tmp_${Date.now()}`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
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
    return JSON.parse(fs.readFileSync(COLLECTOR_DB_FILE, 'utf8'));
  } catch (e) {
    return { users: [], audit_logs: [] };
  }
}

function saveCollectorDb(db) {
  writeJsonAtomic(COLLECTOR_DB_FILE, db);
}

function addCollectorAuditLog(type, message, status = 'SUCCESS') {
  const db = readCollectorDb();
  const newLog = {
    id: Date.now(),
    timestamp: new Date().toISOString(),
    type,
    message,
    status
  };
  db.audit_logs.unshift(newLog);
  if (db.audit_logs.length > 500) db.audit_logs = db.audit_logs.slice(0, 500);
  saveCollectorDb(db);
  collectorSqlite.addAuditLog(type, message, status);
}

// 仅允许同源与显式白名单来源，避免任意站点携带凭据调用内部接口
const ALLOWED_ORIGINS = (process.env.VFUSION_ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('CORS: 来源不被允许'));
  }
}));
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/collector-assets', express.static(COLLECTOR_ASSETS_DIR));
app.use('/assets', express.static(COLLECTOR_ASSETS_DIR));
app.get('/favicon.ico', (req, res) => res.status(204).end());

// 统一鉴权：除登录与静态资源外，所有 /api 路由必须携带有效 Token
app.use('/api', authMiddleware({ publicPaths: ['/api/auth/login', '/api/schema'] }));

// 表单 Schema 配置 API（视频网发布端与可视化构建器）
app.get('/api/schema', (req, res) => {
  const { app_id } = req.query;
  const targetFile = app_id ? path.join(STORAGE_ROOT, `schema_${app_id}.json`) : COLLECTOR_SCHEMA_FILE;
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

app.post('/api/schema', (req, res) => {
  try {
    const newSchema = req.body;
    const appId = newSchema.app_id || 'sys_gate_security';
    const targetFile = path.join(STORAGE_ROOT, `schema_${appId}.json`);
    writeJsonAtomic(targetFile, newSchema);
    writeJsonAtomic(COLLECTOR_SCHEMA_FILE, newSchema);
    addCollectorAuditLog('SCHEMA_UPDATE', `视频网端表单 Schema 已更新 (App: ${appId}, 包含 ${newSchema.fields ? newSchema.fields.length : 0} 个字段)`, 'SUCCESS');
    res.json({ success: true, message: '视频网端表单 Schema 更新成功' });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
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
app.post('/api/auth/login', (req, res) => {
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
  if (!username || !password) {
    return res.status(400).json({ success: false, error: '用户名与初始密码不能为空' });
  }
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
  if (!new_password) {
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
  if (user.username === 'admin') return res.status(403).json({ success: false, error: '超级管理员账号不可删除' });

  db.users.splice(idx, 1);
  saveCollectorDb(db);
  addCollectorAuditLog('USER_DEL', `删除视频网用户 [${user.name}(${user.username})]`, 'WARN');
  res.json({ success: true, message: '用户已删除' });
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

// Schema API
app.get('/api/schema', (req, res) => {
  const { app_id } = req.query;
  const targetFile = app_id ? path.join(STORAGE_ROOT, `schema_${app_id}.json`) : COLLECTOR_SCHEMA_FILE;
  try {
    const fileToRead = fs.existsSync(targetFile) ? targetFile : COLLECTOR_SCHEMA_FILE;
    const schemaObj = JSON.parse(fs.readFileSync(fileToRead, 'utf8'));
    res.json({ success: true, data: schemaObj });
  } catch (e) {
    res.json({ success: true, data: DEFAULT_FORM_SCHEMA });
  }
});

app.post('/api/schema', (req, res) => {
  try {
    const newSchema = req.body;
    const appId = newSchema.app_id || 'sys_gate_security';
    const targetFile = path.join(STORAGE_ROOT, `schema_${appId}.json`);
    writeJsonAtomic(targetFile, newSchema);
    writeJsonAtomic(COLLECTOR_SCHEMA_FILE, newSchema);
    addCollectorAuditLog('SCHEMA_UPDATE', `视频网表单 Schema 已更新 (应用租户: ${appId}, ${newSchema.fields.length} 个字段)`, 'SUCCESS');
    res.json({ success: true, message: '视频网表单 Schema 已成功更新并即时生效' });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 任务管理 API (视频网采集端)
app.get('/api/tasks', async (req, res) => {
  try {
    const tasks = await collectorSqlite.getTasks();
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
    events.forEach(evt => {
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
        collectorSqlite.saveTask(autoTask);
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

app.post('/api/tasks', async (req, res) => {
  try {
    const { task_name, task_code, description, is_shared } = req.body;
    if (!task_name) return res.status(400).json({ success: false, error: '任务名称不能为空' });

    const user = req.user || { username: 'operator', name: '视频网操作员' };
    const datePrefix = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 8);
    const finalCode = task_code && task_code.trim()
      ? task_code.trim()
      : `TASK_${datePrefix}_${Math.floor(1000 + Math.random() * 9000)}`;

    const existing = await collectorSqlite.getTaskByCode(finalCode);
    if (existing) {
      return res.status(400).json({ success: false, error: `任务编号 [${finalCode}] 已存在` });
    }

    const newTask = collectorSqlite.saveTask({
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

    collectorSqlite.updateTaskStatus(code, status);
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
    const task = await collectorSqlite.getTaskByCode(code);
    if (!task) return res.status(404).json({ success: false, error: '任务不存在' });

    const allEvents = await collectorSqlite.getEvents();
    const taskEvents = allEvents.filter(e => e.task_code === code);

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
    const task = await collectorSqlite.getTaskByCode(code);
    if (!task) return res.status(404).json({ success: false, error: '任务不存在' });

    const currentUser = req.user || { username: 'operator' };
    const isAdmin = currentUser.role === 'admin';
    const isCreator = task.creator_username === currentUser.username;

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
    maxFileSize: 100 * 1024 * 1024
  });

  form.parse(req, async (err, fields, files) => {
    if (err) {
      console.error('Form parse error:', err);
      return res.status(400).json({ success: false, error: '解析上传表单失败' });
    }

    try {
      const appId = (fields.app_id && fields.app_id[0]) || 'sys_gate_security';
      const bizType = (fields.biz_type && fields.biz_type[0]) || 'person_snapshot';
      const taskName = (fields.task_name && fields.task_name[0]) || '厂区周界安防例行巡检';
      const taskCode = (fields.task_code && fields.task_code[0]) || `TASK_${Date.now()}`;
      const operatorUsername = (fields.operator_username && fields.operator_username[0]) || 'operator';
      const operatorName = (fields.operator_name && fields.operator_name[0]) || '视频网操作员';
      const operator = (fields.operator && fields.operator[0]) || `${operatorName} (${operatorUsername})`;
      const submitTime = (fields.submit_time && fields.submit_time[0]) || new Date().toISOString();
      const eventId = (fields.event_id && fields.event_id[0]) || `${Date.now()}`;

      const payload = {};
      for (const [key, value] of Object.entries(fields)) {
        if (!['app_id', 'biz_type', 'task_name', 'task_code', 'operator', 'operator_username', 'operator_name', 'submit_time', 'event_id'].includes(key)) {
          payload[key] = Array.isArray(value) ? value[0] : value;
        }
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
      const eventAssetDir = path.join(COLLECTOR_ASSETS_DIR, eventId);
      if (!fs.existsSync(eventAssetDir)) fs.mkdirSync(eventAssetDir, { recursive: true });

      if (files.images) {
        const rawFiles = Array.isArray(files.images) ? files.images : [files.images];
        for (let i = 0; i < rawFiles.length; i++) {
          const fileObj = rawFiles[i];
          const ext = path.extname(fileObj.originalFilename || fileObj.filepath) || '.jpg';
          const filename = `${String(i + 1).padStart(3, '0')}${ext}`;
          fileList.push({
            path: fileObj.filepath,
            filename: filename
          });
          const localDest = path.join(eventAssetDir, filename);
          try { fs.copyFileSync(fileObj.filepath, localDest); } catch (e) {}
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
      const targetSchemaFile = path.join(STORAGE_ROOT, `schema_${appId}.json`);
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
      collectorSqlite.saveEvent({
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
        collectorSqlite.saveTask({
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
        collectorSqlite.saveTask({
          ...existingTask,
          task_name: taskName || existingTask.task_name,
          updated_at: new Date().toISOString()
        });
      }

      // 如果配置并启用了第三方远程 FTP 服务器，自动将生成的 Zip 包上传至 FTP
      let ftpNotice = ' (远程 FTP 未开启，包已存入本地网闸目录)';
      try {
        if (fs.existsSync(SECURITY_CONFIG_FILE)) {
          const sec = JSON.parse(fs.readFileSync(SECURITY_CONFIG_FILE, 'utf8'));
          if (sec && sec.ftp_enabled && sec.ftp_host) {
            try {
              const ftpRes = await uploadToRemoteFtp(result.zipPath, `${result.pkgName}.zip`, sec);
              const remoteName = (ftpRes && ftpRes.remoteFileName) ? ftpRes.remoteFileName : `${result.pkgName}.zip`;
              ftpNotice = ` (已自动同步推送至 FTP 文件: ${remoteName})`;
              addCollectorAuditLog('FTP_UPLOAD', `同步推送单据至远程 FTP 服务器 [${sec.ftp_host}:${sec.ftp_port || 21}${sec.ftp_remote_dir || '/'}/${remoteName}] 成功`, 'SUCCESS');
            } catch (ftpErr) {
              console.error('[VFusion Collector] 同步远程 FTP 异常:', ftpErr);
              ftpNotice = ` (推送远程 FTP 失败: ${ftpErr.message})`;
              addCollectorAuditLog('ERROR', `推送到远程 FTP 服务器失败: ${ftpErr.message}`, 'WARN');
            }
          }
        }
      } catch (e) {}

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
    }
  });
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
          hmac_secret: sec.hmac_secret || ''
        }
      });
    }
  } catch (e) {}
  res.json({
    success: true,
    data: { ftp_enabled: false, ftp_host: '', ftp_port: 21, ftp_user: '', ftp_password: '', ftp_remote_dir: '/vfusion_packages', pkg_prefix: 'vfusion_', ftp_file_ext: '.jpg', hmac_secret: '' }
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

app.listen(PORT, '0.0.0.0', () => {
  const localIps = getLocalIps();
  console.log(`===================================================`);
  console.log(` 视频网数据采集/发布终端 (VFusion Collector v0.10.0) 已启动`);
  console.log(` 本机访问地址: http://localhost:${PORT}`);
  localIps.forEach(ip => {
    console.log(` 局域网/其他电脑访问地址: http://${ip}:${PORT}`);
  });
  console.log(`===================================================`);
});
