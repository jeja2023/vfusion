const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { formidable } = require('formidable');
const { packEventPackage } = require('../common/packager');
const { DEFAULT_FORM_SCHEMA } = require('../common/protocol');
const { testFtpConnection, uploadToRemoteFtp } = require('../common/ftp_client');

const app = express();
const PORT = process.env.PORT || 4001;

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

const COLLECTOR_ASSETS_DIR = path.join(STORAGE_ROOT, 'collector_assets');
if (!fs.existsSync(COLLECTOR_ASSETS_DIR)) fs.mkdirSync(COLLECTOR_ASSETS_DIR, { recursive: true });

app.use('/collector-assets', express.static(COLLECTOR_ASSETS_DIR));

const SQLiteStorageEngine = require('../common/db_sqlite');

const collectorSqlite = new SQLiteStorageEngine(path.join(STORAGE_ROOT, 'vfusion_collector.db'));

// 初始化视频网本地数据库（用户与审计日志）
function readCollectorDb() {
  if (!fs.existsSync(COLLECTOR_DB_FILE)) {
    const defaultDb = {
      users: [
        { id: 1, username: 'admin', password: '123', name: '视频网管理员', role: 'admin', status: 'active' },
        { id: 2, username: 'operator', password: '123', name: '视频网操作员', role: 'operator', status: 'active' },
        { id: 3, username: 'auditor', password: '123', name: '视频网审计员', role: 'auditor', status: 'active' }
      ],
      audit_logs: [
        { id: 1, timestamp: new Date().toISOString(), type: 'AUTH_SUCCESS', message: '视频网系统超级管理员 (admin) 登录成功', status: 'SUCCESS' }
      ]
    };
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

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/favicon.ico', (req, res) => res.status(204).end());

// 涉事人员库 API
app.get('/api/personnel', (req, res) => {
  const db = readCollectorDb();
  res.json({ success: true, data: db.personnel || [] });
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

// 登录 API
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  const db = readCollectorDb();
  const user = db.users.find(u => u.username === username && u.password === password);

  if (user) {
    addCollectorAuditLog('AUTH_SUCCESS', `视频网用户 [${user.name}(${user.username})] 登录系统成功 (角色: ${user.role})`, 'SUCCESS');
    res.json({
      success: true,
      data: {
        token: `vfusion_coll_token_${Date.now()}`,
        user: { id: user.id, username: user.username, name: user.name, role: user.role }
      }
    });
  } else {
    addCollectorAuditLog('AUTH_FAIL', `视频网用户尝试登录失败 (用户名: ${username})`, 'WARN');
    res.status(401).json({ success: false, error: '用户名或密码错误' });
  }
});

// 用户管理 API
app.get('/api/users', (req, res) => {
  const db = readCollectorDb();
  res.json({ success: true, data: db.users.map(u => ({ id: u.id, username: u.username, name: u.name, role: u.role, status: u.status })) });
});

app.post('/api/users', (req, res) => {
  const { username, password, name, role } = req.body;
  const db = readCollectorDb();
  if (db.users.some(u => u.username === username)) {
    return res.status(400).json({ success: false, error: '用户名已存在' });
  }
  const newUser = {
    id: Date.now(),
    username,
    password: password || '123456',
    name: name || username,
    role: role || 'operator',
    status: 'active'
  };
  db.users.push(newUser);
  saveCollectorDb(db);
  addCollectorAuditLog('USER_ADD', `新增视频网用户 [${name}(${username})] (角色: ${role})`, 'SUCCESS');
  res.json({ success: true, data: newUser });
});

app.put('/api/users/:id/reset-password', (req, res) => {
  const { id } = req.params;
  const { new_password } = req.body;
  const db = readCollectorDb();
  const user = db.users.find(u => u.id === parseInt(id));
  if (!user) return res.status(404).json({ success: false, error: '用户不存在' });

  user.password = new_password || '123456';
  saveCollectorDb(db);
  addCollectorAuditLog('USER_PWD_RESET', `重置视频网用户 [${user.name}(${user.username})] 密码成功`, 'SUCCESS');
  res.json({ success: true, message: '密码重置成功' });
});

app.delete('/api/users/:id', (req, res) => {
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
          domicile: payload.person_domicile || ''
        };
        if (existingIdx >= 0) {
          db.personnel[existingIdx] = { ...db.personnel[existingIdx], ...personRec };
        } else {
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
            filename: filename,
            url: `/collector-assets/${eventId}/${filename}`
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

      addCollectorAuditLog('INGEST', `成功打包投递单据: ${result.pkgName}.zip (应用租户: ${appId}, 操作员: ${operator})`, 'SUCCESS');

      // 如果配置并启用了第三方远程 FTP 服务器，自动将生成的 Zip 包上传至 FTP
      try {
        if (fs.existsSync(SECURITY_CONFIG_FILE)) {
          const sec = JSON.parse(fs.readFileSync(SECURITY_CONFIG_FILE, 'utf8'));
          if (sec && sec.ftp_enabled && sec.ftp_host) {
            await uploadToRemoteFtp(result.zipPath, `${result.pkgName}.zip`, sec);
            addCollectorAuditLog('FTP_UPLOAD', `同步推送单据至远程 FTP 服务器 [${sec.ftp_host}:${sec.ftp_port || 21}${sec.ftp_remote_dir || '/'}/${result.pkgName}.zip] 成功`, 'SUCCESS');
          }
        }
      } catch (ftpErr) {
        console.error('[VFusion Collector] 同步远程 FTP 异常:', ftpErr);
        addCollectorAuditLog('ERROR', `推送到远程 FTP 服务器失败: ${ftpErr.message}`, 'WARN');
      }

      res.json({
        success: true,
        message: '数据已成功打包并投递至网闸/FTP发送目录',
        data: {
          pkgName: result.pkgName,
          zipPath: result.zipPath,
          size: result.size,
          info: result.info
        }
      });
    } catch (error) {
      console.error('[VFusion Collector] 打包异常:', error);
      addCollectorAuditLog('ERROR', `打包投递失败: ${error.message}`, 'ERROR');
      res.status(500).json({ success: false, error: error.message });
    }
  });
});

// 视频网采集端：获取与保存 FTP 配置 API
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
          ftp_password: sec.ftp_password || '',
          ftp_remote_dir: sec.ftp_remote_dir || '/vfusion_packages',
          pkg_prefix: sec.pkg_prefix || 'vfusion_'
        }
      });
    }
  } catch (e) {}
  res.json({
    success: true,
    data: { ftp_enabled: false, ftp_host: '', ftp_port: 21, ftp_user: '', ftp_password: '', ftp_remote_dir: '/vfusion_packages', pkg_prefix: 'vfusion_' }
  });
});

app.post('/api/config/ftp', (req, res) => {
  try {
    let sec = {};
    if (fs.existsSync(SECURITY_CONFIG_FILE)) {
      sec = JSON.parse(fs.readFileSync(SECURITY_CONFIG_FILE, 'utf8'));
    }
    const { ftp_enabled, ftp_host, ftp_port, ftp_user, ftp_password, ftp_remote_dir, pkg_prefix } = req.body;
    if (typeof ftp_enabled === 'boolean') sec.ftp_enabled = ftp_enabled;
    if (typeof ftp_host === 'string') sec.ftp_host = ftp_host;
    if (typeof ftp_port === 'number' || typeof ftp_port === 'string') sec.ftp_port = parseInt(ftp_port) || 21;
    if (typeof ftp_user === 'string') sec.ftp_user = ftp_user;
    if (typeof ftp_password === 'string') sec.ftp_password = ftp_password;
    if (typeof ftp_remote_dir === 'string') sec.ftp_remote_dir = ftp_remote_dir;
    if (typeof pkg_prefix === 'string') sec.pkg_prefix = pkg_prefix;

    writeJsonAtomic(SECURITY_CONFIG_FILE, sec);
    addCollectorAuditLog('FTP_CONFIG', `视频网端配置第三方 FTP 服务器 (${sec.ftp_enabled ? '已启用' : '未启用'}, Host: ${sec.ftp_host}:${sec.ftp_port})`, 'SUCCESS');
    res.json({ success: true, message: '视频网端第三方 FTP 配置保存成功' });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/config/ftp/test', async (req, res) => {
  try {
    const config = req.body;
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

app.listen(PORT, () => {
  console.log(`===================================================`);
  console.log(` 视频网数据采集/发布终端 (VFusion Collector v0.9.15) 已启动`);
  console.log(` 运行地址: http://localhost:${PORT}`);
  console.log(`===================================================`);
});
