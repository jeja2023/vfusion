const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('./json_store');

/**
 * 视汇 (VFusion) 嵌入式 SQLite 高性能数据库引擎
 * 包含了二进制原生 sqlite3 驱动封装与数据自动平滑迁移
 */

let sqlite3 = null;
try {
  sqlite3 = require('sqlite3').verbose();
} catch (e) {
  console.warn('[VFusion DB] sqlite3 原生驱动未就绪，使用内置轻量 SQL 内存映射存储引擎');
}

class SQLiteStorageEngine {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = null;
    this.isNative = false;
    this.eventIdCounter = Date.now();
    this.taskIdCounter = Date.now();
    this.pendingWrites = Promise.resolve();
    this.init();
  }

  init() {
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    if (sqlite3) {
      this.isNative = true;
      this.db = new sqlite3.Database(this.dbPath, (err) => {
        if (err) console.error('[VFusion SQLite] 连接数据库失败:', err);
        else console.log(`[VFusion SQLite] 已连接到 SQLite 数据库文件: ${path.basename(this.dbPath)}`);
      });

      this.db.run('PRAGMA journal_mode = WAL');
      this.db.run('PRAGMA busy_timeout = 5000');

      this.createTablesNative();
    }
  }

  createTablesNative() {
    if (!this.db) return;
    this.db.serialize(() => {
      // 1. 单据事件表
      this.db.run(`
        CREATE TABLE IF NOT EXISTS events (
          id INTEGER PRIMARY KEY,
          app_id TEXT,
          biz_type TEXT,
          event_id TEXT UNIQUE,
          task_name TEXT,
          task_code TEXT,
          timestamp TEXT,
          operator TEXT,
          operator_username TEXT,
          operator_name TEXT,
          payload TEXT,
          files TEXT,
          zip_hash TEXT,
          signature TEXT,
          ai_tags TEXT,
          status TEXT,
          created_at TEXT
        )
      `);
      // 平滑数据库迁移：补全 task_name 和 task_code 字段
      this.db.run(`ALTER TABLE events ADD COLUMN task_name TEXT`, () => {});
      this.db.run(`ALTER TABLE events ADD COLUMN task_code TEXT`, () => {});
      this.db.run(`ALTER TABLE events ADD COLUMN operator_username TEXT`, () => {});
      this.db.run(`ALTER TABLE events ADD COLUMN operator_name TEXT`, () => {});

      // 2. 系统安全审计日志表
      this.db.run(`
        CREATE TABLE IF NOT EXISTS audit_logs (
          id INTEGER PRIMARY KEY,
          timestamp TEXT,
          type TEXT,
          message TEXT,
          status TEXT
        )
      `);

      // 3. 系统告警表
      this.db.run(`
        CREATE TABLE IF NOT EXISTS alerts (
          id INTEGER PRIMARY KEY,
          timestamp TEXT,
          title TEXT,
          message TEXT,
          level TEXT,
          read INTEGER DEFAULT 0
        )
      `);

      // 4. 用户表
      this.db.run(`
        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY,
          username TEXT UNIQUE,
          name TEXT,
          password TEXT,
          role TEXT,
          status TEXT,
          created_at TEXT
        )
      `);

      // 5. 消息订阅 Webhooks 表
      this.db.run(`
        CREATE TABLE IF NOT EXISTS webhooks (
          id INTEGER PRIMARY KEY,
          name TEXT,
          url TEXT,
          created_at TEXT
        )
      `);

      // 6. 任务表 (Task Management)
      this.db.run(`
        CREATE TABLE IF NOT EXISTS tasks (
          id INTEGER PRIMARY KEY,
          task_code TEXT UNIQUE,
          task_name TEXT,
          description TEXT,
          creator_username TEXT,
          creator_name TEXT,
          share_code TEXT,
          is_shared INTEGER DEFAULT 1,
          shared_users TEXT DEFAULT '[]',
          status TEXT DEFAULT 'ACTIVE',
          created_at TEXT,
          updated_at TEXT
        )
      `);
      this.db.run(`ALTER TABLE tasks ADD COLUMN shared_users TEXT DEFAULT '[]'`, () => {});
      this.db.run('CREATE INDEX IF NOT EXISTS idx_events_task_code ON events(task_code)');
      this.db.run('CREATE INDEX IF NOT EXISTS idx_events_app_id ON events(app_id)');
      this.db.run('CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp)');
      this.db.run('CREATE INDEX IF NOT EXISTS idx_tasks_share_code ON tasks(share_code)');
    });
  }

  parseJson(value, fallback) {
    try { return typeof value === 'string' ? JSON.parse(value || JSON.stringify(fallback)) : (value ?? fallback); }
    catch (e) { return fallback; }
  }

  writeFallback(filePath, list) {
    writeJsonAtomic(filePath, list);
  }

  // 写入事件单据
  saveEvent(record) {
    const norm = {
      id: record.id || ++this.eventIdCounter,
      app_id: record.app_id || 'sys_gate_security',
      biz_type: record.biz_type || 'GENERAL',
      event_id: record.event_id,
      task_name: record.task_name || '默认安防巡检任务',
      task_code: record.task_code || 'TASK_DEFAULT',
      timestamp: record.timestamp,
      operator: record.operator,
      operator_username: record.operator_username || '',
      operator_name: record.operator_name || '',
      payload: record.payload || {},
      files: record.files || [],
      zip_hash: record.zip_hash || '',
      signature: record.signature || '',
      ai_tags: record.ai_tags || [],
      status: record.status || 'RECEIVED',
      created_at: record.created_at || new Date().toISOString()
    };
    if (!this.isNative || !this.db) {
      const jsonPath = `${this.dbPath}.fallback.json`;
      let list = this.parseJson(fs.existsSync(jsonPath) ? fs.readFileSync(jsonPath, 'utf8') : '[]', []);
      const existingIdx = list.findIndex(e => e.event_id === norm.event_id);
      if (existingIdx >= 0) list[existingIdx] = norm; else list.unshift(norm);
      this.writeFallback(jsonPath, list);
      return Promise.resolve(norm);
    }
    const operation = () => new Promise((resolve, reject) => {
      this.db.serialize(() => this.db.run(`
        INSERT INTO events (id, app_id, biz_type, event_id, task_name, task_code, timestamp, operator, operator_username, operator_name, payload, files, zip_hash, signature, ai_tags, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(event_id) DO UPDATE SET
          app_id=excluded.app_id, biz_type=excluded.biz_type, task_name=excluded.task_name,
          task_code=excluded.task_code, timestamp=excluded.timestamp, operator=excluded.operator,
          operator_username=excluded.operator_username, operator_name=excluded.operator_name,
          payload=excluded.payload, files=excluded.files, zip_hash=excluded.zip_hash,
          signature=excluded.signature, ai_tags=excluded.ai_tags, status=excluded.status,
          created_at=excluded.created_at
      `, [norm.id, norm.app_id, norm.biz_type, norm.event_id, norm.task_name, norm.task_code, norm.timestamp, norm.operator,
        norm.operator_username, norm.operator_name, JSON.stringify(norm.payload), JSON.stringify(norm.files), norm.zip_hash, norm.signature, JSON.stringify(norm.ai_tags), norm.status, norm.created_at], function (err) {
        if (err) return reject(err);
        resolve(norm);
      }));
    });
    this.pendingWrites = this.pendingWrites.catch(() => {}).then(operation);
    return this.pendingWrites.then(() => norm);
  }

  // 查询事件单据列表
  getEvents(appId = null, options = {}) {
    const limit = Math.min(Math.max(Number(options.limit) || 1000, 1), 100000);
    const offset = Math.max(Number(options.offset) || 0, 0);
    const taskCode = options.taskCode || null;
    return new Promise((resolve) => {
      if (this.isNative && this.db) {
        let sql = 'SELECT * FROM events WHERE 1=1';
        let params = [];
        if (appId) { sql += ' AND app_id = ?'; params.push(appId); }
        if (taskCode) { sql += ' AND task_code = ?'; params.push(taskCode); }
        sql += ' ORDER BY id DESC LIMIT ? OFFSET ?';
        params.push(limit, offset);
        this.pendingWrites.then(() => this.db.all(sql, params, (err, rows) => {
          if (err) return resolve(this.getFallbackEvents(appId, { taskCode, limit, offset }));
          if (!rows || rows.length === 0) return resolve([]);
          const results = rows.map(r => ({
            ...r,
            payload: this.parseJson(r.payload, {}),
            files: this.parseJson(r.files, []),
            ai_tags: this.parseJson(r.ai_tags, [])
          }));
          resolve(results);
        })).catch(() => resolve([]));
      } else {
        resolve(this.getFallbackEvents(appId, { taskCode, limit, offset }));
      }
    });
  }

  getFallbackEvents(appId = null, options = {}) {
    try {
      let list = this.getAllFallbackEvents();
      if (list.length > 0) {
        if (appId) list = list.filter(e => e.app_id === appId);
        if (options.taskCode) list = list.filter(e => e.task_code === options.taskCode);
        const limit = Math.min(Math.max(Number(options.limit) || 1000, 1), 100000);
        const offset = Math.max(Number(options.offset) || 0, 0);
        return list.slice(offset, offset + limit);
      }
    } catch (e) {}
    return [];
  }

  getAllFallbackEvents() {
    try {
      const jsonPath = `${this.dbPath}.fallback.json`;
      return fs.existsSync(jsonPath) ? this.parseJson(fs.readFileSync(jsonPath, 'utf8'), []) : [];
    } catch (e) {
      return [];
    }
  }

  getEventByEventId(eventId) {
    if (!eventId) return Promise.resolve(null);
    return new Promise((resolve) => {
      if (this.isNative && this.db) {
        this.pendingWrites.then(() => this.db.get('SELECT * FROM events WHERE event_id = ?', [eventId], (err, row) => {
          if (err || !row) return resolve(this.getAllFallbackEvents().find(event => event.event_id === eventId) || null);
          resolve({ ...row, payload: this.parseJson(row.payload, {}), files: this.parseJson(row.files, []), ai_tags: this.parseJson(row.ai_tags, []) });
        })).catch(() => resolve(null));
      } else {
        resolve(this.getAllFallbackEvents().find(event => event.event_id === eventId) || null);
      }
    });
  }

  getEventByHash(zipHash) {
    if (!zipHash) return Promise.resolve(null);
    return new Promise((resolve) => {
      if (this.isNative && this.db) {
        this.pendingWrites.then(() => this.db.get('SELECT event_id, zip_hash FROM events WHERE zip_hash = ? LIMIT 1', [zipHash], (err, row) => {
          if (err || !row) return resolve(this.getAllFallbackEvents().find(event => event.zip_hash === zipHash) || null);
          resolve(row);
        })).catch(() => resolve(null));
      } else {
        resolve(this.getAllFallbackEvents().find(event => event.zip_hash === zipHash) || null);
      }
    });
  }

  getEventCount() {
    return new Promise((resolve) => {
      if (this.isNative && this.db) {
        this.pendingWrites.then(() => this.db.get('SELECT COUNT(*) AS count FROM events', [], (err, row) => {
          resolve(err ? this.getAllFallbackEvents().length : Number(row && row.count) || 0);
        })).catch(() => resolve(0));
      } else {
        resolve(this.getAllFallbackEvents().length);
      }
    });
  }

  getTaskStats() {
    return new Promise((resolve) => {
      if (this.isNative && this.db) {
        const sql = `SELECT task_code, COUNT(*) AS event_count, MAX(timestamp) AS latest_timestamp,
          GROUP_CONCAT(DISTINCT operator) AS contributors, SUM(COALESCE(json_array_length(files), 0)) AS photo_count
          FROM events GROUP BY task_code`;
        this.pendingWrites.then(() => this.db.all(sql, [], (err, rows) => {
          if (err) return resolve(this.getFallbackTaskStats());
          const result = {};
          for (const row of rows || []) {
            result[row.task_code || 'TASK_DEFAULT'] = {
              event_count: Number(row.event_count) || 0,
              photo_count: Number(row.photo_count) || 0,
              contributors: row.contributors ? String(row.contributors).split(',') : [],
              latest_timestamp: row.latest_timestamp
            };
          }
          resolve(result);
        })).catch(() => resolve(this.getFallbackTaskStats()));
      } else {
        resolve(this.getFallbackTaskStats());
      }
    });
  }

  getFallbackTaskStats() {
    const result = {};
    for (const event of this.getAllFallbackEvents()) {
      const code = event.task_code || 'TASK_DEFAULT';
      const stat = result[code] || { event_count: 0, photo_count: 0, contributors: [], latest_timestamp: event.timestamp || event.created_at };
      stat.event_count += 1;
      stat.photo_count += Array.isArray(event.files) ? event.files.length : 0;
      if (event.operator && !stat.contributors.includes(event.operator)) stat.contributors.push(event.operator);
      if (new Date(event.timestamp) > new Date(stat.latest_timestamp)) stat.latest_timestamp = event.timestamp;
      result[code] = stat;
    }
    return result;
  }

  // 写入审计日志
  addAuditLog(type, message, status = 'INFO') {
    if (!this.isNative || !this.db) return Promise.resolve();
    const operation = () => new Promise((resolve, reject) => this.db.serialize(() => this.db.run(`
      INSERT INTO audit_logs (id, timestamp, type, message, status)
      VALUES (?, ?, ?, ?, ?)
    `, [Date.now(), new Date().toISOString(), type, message, status], err => err ? reject(err) : resolve())));
    this.pendingWrites = this.pendingWrites.catch(() => {}).then(operation);
    return this.pendingWrites;
  }

  // 获取审计日志
  getAuditLogs(keyword = '', statusFilter = '', typeFilter = '') {
    const AUDIT_TYPE_MAP = {
      'AUTH_SUCCESS': '用户登录成功', 'AUTH_FAIL': '用户登录失败', 'USER_ADD': '新增用户账号',
      'USER_UPDATE': '修改用户信息', 'USER_DEL': '删除用户账号', 'USER_PWD_RESET': '重置用户密码',
      'USER_PWD_UPGRADE': '升级密码安全加密', 'INGEST': '单据发布打包', 'SCANNER': '摆渡目录自动扫描',
      'IDEMPOTENCY': '幂等去重归档', 'DIODE_SIM': '网闸模拟摆渡', 'DIODE_CONFIG': '摆渡频率配置',
      'DOWNLOAD': '现场存照附件下载', 'TASK_CREATE': '创建巡检任务', 'TASK_EDIT': '修改任务信息',
      'TASK_DELETE': '删除任务与单据', 'TASK_STATUS': '变更任务执行状态', 'TASK_SHARE_UPDATE': '更新任务共享码',
      'TASK_IMAGE_EDIT': '编辑照片描述与坐标', 'TASK_IMAGE_DELETE': '删除任务现场照片', 'MONITORING_POINT_ADD': '新增监控点位',
      'MONITORING_POINT_UPDATE': '修改监控点位', 'MONITORING_POINT_TOGGLE': '启停监控点位', 'MONITORING_POINT_IMPORT': '批量导入监控点位',
      'PERSONNEL_EDIT': '修改人员档案', 'PERSONNEL_DELETE': '删除人员档案', 'SCHEMA_UPDATE': '动态表单Schema更新',
      'FTP_CONFIG': 'FTP通道参数配置', 'FTP_POLL': 'FTP远程自动轮询', 'FTP_PULL': 'FTP手动拉取数据',
      'FTP_UPLOAD': 'FTP数据包自动推送', 'FTP_TEST': 'FTP通道连通性测试', 'WEBHOOK': 'Webhook消息推送',
      'WEBHOOK_ADD': '新增Webhook订阅', 'WEBHOOK_UPDATE': '修改Webhook配置', 'WEBHOOK_DEL': '移除Webhook订阅',
      'WEBHOOK_TEST': 'Webhook连通性测试', 'WEBHOOK_SECRET_ROTATE': 'Webhook签名密钥轮换', 'MAP_CONFIG': '离线地图参数配置',
      'SECURITY': '安全秘钥在线轮换', 'SYSTEM_UPGRADE': '系统在线无损热升级', 'CLEANUP': '清理历史归档数据',
      'DIAGNOSE': '系统运行状态诊断', 'EXPORT_AUDIT': '导出系统审计日志', 'SYSTEM': '系统核心服务就绪', 'ERROR': '系统异常与错误'
    };

    return new Promise((resolve) => {
      if (this.isNative && this.db) {
        let sql = 'SELECT * FROM audit_logs WHERE 1=1';
        let params = [];
        if (keyword) {
          const kwLower = keyword.toLowerCase();
          const matchedKeys = Object.keys(AUDIT_TYPE_MAP).filter(k => AUDIT_TYPE_MAP[k].toLowerCase().includes(kwLower));
          if (matchedKeys.length > 0) {
            const placeholders = matchedKeys.map(() => '?').join(',');
            sql += ` AND (message LIKE ? OR type LIKE ? OR type IN (${placeholders}))`;
            params.push(`%${keyword}%`, `%${keyword}%`, ...matchedKeys);
          } else {
            sql += ' AND (message LIKE ? OR type LIKE ?)';
            params.push(`%${keyword}%`, `%${keyword}%`);
          }
        }
        if (statusFilter) {
          sql += ' AND status = ?';
          params.push(statusFilter);
        }
        if (typeFilter) {
          sql += ' AND type = ?';
          params.push(typeFilter);
        }
        sql += ' ORDER BY id DESC LIMIT 500';
        this.pendingWrites.then(() => this.db.all(sql, params, (err, rows) => {
          if (err) return resolve([]);
          resolve(rows);
        })).catch(() => resolve([]));
      } else {
        resolve([]);
      }
    });
  }

  // 任务管理: 保存/更新任务
  saveTask(task) {
    const now = new Date().toISOString();
    const sharedUsersArr = Array.isArray(task.shared_users) ? task.shared_users : this.parseJson(task.shared_users, []);
    const taskRecord = {
      id: task.id || ++this.taskIdCounter,
      task_code: task.task_code,
      task_name: task.task_name || '未命名任务',
      description: task.description || '',
      creator_username: task.creator_username || 'operator',
      creator_name: task.creator_name || '视频网操作员',
      share_code: task.share_code || task.task_code,
      is_shared: task.is_shared !== undefined ? (task.is_shared ? 1 : 0) : 1,
      shared_users: sharedUsersArr,
      status: task.status || 'ACTIVE',
      created_at: task.created_at || now,
      updated_at: now
    };

    if (!this.isNative || !this.db) {
      const jsonPath = `${this.dbPath}.tasks_fallback.json`;
      let list = fs.existsSync(jsonPath) ? this.parseJson(fs.readFileSync(jsonPath, 'utf8'), []) : [];
      const existingIdx = list.findIndex(t => t.task_code === taskRecord.task_code);
      if (existingIdx >= 0) list[existingIdx] = { ...list[existingIdx], ...taskRecord };
      else list.unshift(taskRecord);
      this.writeFallback(jsonPath, list);
      return Promise.resolve(taskRecord);
    }
    const operation = () => new Promise((resolve, reject) => this.db.serialize(() => this.db.run(`
      INSERT INTO tasks (id, task_code, task_name, description, creator_username, creator_name, share_code, is_shared, shared_users, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_code) DO UPDATE SET task_name=excluded.task_name, description=excluded.description,
        creator_username=excluded.creator_username, creator_name=excluded.creator_name, share_code=excluded.share_code,
        is_shared=excluded.is_shared, shared_users=excluded.shared_users, status=excluded.status,
        created_at=excluded.created_at, updated_at=excluded.updated_at
    `, [taskRecord.id, taskRecord.task_code, taskRecord.task_name, taskRecord.description, taskRecord.creator_username,
      taskRecord.creator_name, taskRecord.share_code, taskRecord.is_shared, JSON.stringify(taskRecord.shared_users),
      taskRecord.status, taskRecord.created_at, taskRecord.updated_at], err => err ? reject(err) : resolve(taskRecord))));
    this.pendingWrites = this.pendingWrites.catch(() => {}).then(operation);
    return this.pendingWrites.then(() => taskRecord);
  }

  // 获取所有任务
  getTasks() {
    return new Promise((resolve) => {
      if (this.isNative && this.db) {
        this.pendingWrites.then(() => this.db.all('SELECT * FROM tasks ORDER BY updated_at DESC', [], (err, rows) => {
          if (err || !rows || rows.length === 0) return resolve(this.getFallbackTasks());
          resolve(rows.map(r => ({
            ...r,
            is_shared: Boolean(r.is_shared),
            shared_users: this.parseJson(r.shared_users, [])
          })));
        })).catch(() => resolve(this.getFallbackTasks()));
      } else {
        resolve(this.getFallbackTasks());
      }
    });
  }

  getFallbackTasks() {
    try {
      const jsonPath = `${this.dbPath}.tasks_fallback.json`;
      if (fs.existsSync(jsonPath)) {
        const list = this.parseJson(fs.readFileSync(jsonPath, 'utf8'), []);
        return list.map(t => ({
          ...t,
          shared_users: Array.isArray(t.shared_users) ? t.shared_users : []
        }));
      }
    } catch (e) {}
    return [];
  }

  getTaskByCode(taskCode) {
    return new Promise((resolve) => {
      if (this.isNative && this.db) {
        this.pendingWrites.then(() => this.db.get('SELECT * FROM tasks WHERE task_code = ? OR share_code = ?', [taskCode, taskCode], (err, row) => {
          if (err || !row) return resolve(this.getFallbackTasks().find(t => t.task_code === taskCode || t.share_code === taskCode) || null);
          resolve({
            ...row,
            is_shared: Boolean(row.is_shared),
            shared_users: this.parseJson(row.shared_users, [])
          });
        })).catch(() => resolve(null));
      } else {
        resolve(this.getFallbackTasks().find(t => t.task_code === taskCode || t.share_code === taskCode) || null);
      }
    });
  }

  updateTaskStatus(taskCode, status) {
    const now = new Date().toISOString();
    if (!this.isNative || !this.db) {
      const jsonPath = `${this.dbPath}.tasks_fallback.json`;
      if (fs.existsSync(jsonPath)) {
        let list = this.parseJson(fs.readFileSync(jsonPath, 'utf8'), []);
        const t = list.find(x => x.task_code === taskCode);
        if (t) { t.status = status; t.updated_at = now; }
        this.writeFallback(jsonPath, list);
      }
      return Promise.resolve();
    }
    const operation = () => new Promise((resolve, reject) => this.db.serialize(() => this.db.run('UPDATE tasks SET status = ?, updated_at = ? WHERE task_code = ?', [status, now, taskCode], err => err ? reject(err) : resolve())));
    this.pendingWrites = this.pendingWrites.catch(() => {}).then(operation);
    return this.pendingWrites;
  }

  // 编辑任务详情
  async updateTaskDetails(taskCode, updates = {}) {
    const now = new Date().toISOString();
    const task = await this.getTaskByCode(taskCode);
    if (!task) return null;
    const updatedTask = {
          ...task,
          task_name: updates.task_name !== undefined ? updates.task_name : task.task_name,
          description: updates.description !== undefined ? updates.description : task.description,
          is_shared: updates.is_shared !== undefined ? (updates.is_shared ? 1 : 0) : task.is_shared,
          shared_users: updates.shared_users !== undefined ? (Array.isArray(updates.shared_users) ? updates.shared_users : this.parseJson(updates.shared_users, [])) : (task.shared_users || []),
          status: updates.status || task.status,
          updated_at: now
        };
    if (this.isNative && this.db) {
      await this.pendingWrites;
      await new Promise((resolve, reject) => this.db.run(
        'UPDATE tasks SET task_name = ?, description = ?, is_shared = ?, shared_users = ?, status = ?, updated_at = ? WHERE task_code = ?',
        [updatedTask.task_name, updatedTask.description, updatedTask.is_shared ? 1 : 0, JSON.stringify(updatedTask.shared_users), updatedTask.status, now, taskCode], err => err ? reject(err) : resolve()
      ));
    } else {
          const jsonPath = `${this.dbPath}.tasks_fallback.json`;
          if (fs.existsSync(jsonPath)) {
            let list = this.parseJson(fs.readFileSync(jsonPath, 'utf8'), []);
            const idx = list.findIndex(x => x.task_code === taskCode);
            if (idx >= 0) { list[idx] = { ...list[idx], ...updatedTask }; }
            this.writeFallback(jsonPath, list);
          }
    }
    return updatedTask;
  }

  // 删除任务
  deleteTask(taskCode) {
    if (this.isNative && this.db) {
      const operation = () => new Promise((resolve, reject) => this.db.serialize(() => {
        this.db.run('BEGIN IMMEDIATE TRANSACTION');
        this.db.run('DELETE FROM events WHERE task_code = ?', [taskCode], (eventErr) => {
          if (eventErr) return this.db.run('ROLLBACK', () => reject(eventErr));
          this.db.run('DELETE FROM tasks WHERE task_code = ?', [taskCode], (taskErr) => {
            if (taskErr) return this.db.run('ROLLBACK', () => reject(taskErr));
            this.db.run('COMMIT', commitErr => commitErr ? reject(commitErr) : resolve(true));
          });
        });
      }));
      this.pendingWrites = this.pendingWrites.catch(() => {}).then(operation);
      return this.pendingWrites;
    }
    try {
        const jsonPath = `${this.dbPath}.tasks_fallback.json`;
        if (fs.existsSync(jsonPath)) {
          let list = this.parseJson(fs.readFileSync(jsonPath, 'utf8'), []);
          list = list.filter(x => x.task_code !== taskCode);
          this.writeFallback(jsonPath, list);
        }
        const eventJsonPath = `${this.dbPath}.fallback.json`;
        if (fs.existsSync(eventJsonPath)) {
          const events = this.getAllFallbackEvents().filter(event => event.task_code !== taskCode);
          this.writeFallback(eventJsonPath, events);
        }
    } catch (e) { return Promise.reject(e); }
    return Promise.resolve(true);
  }

  // 获取任务下按时间顺序（Chronological Order）排列的所有图片
  async getTaskImages(taskCode = null, sortOrder = 'ASC') {
    const events = await this.getEvents(null, { taskCode, limit: 100000 });
    const images = [];
    events.forEach(evt => {
      const files = evt.files || [];
      const payload = evt.payload || {};
      let uploaderUsername = evt.operator_username || '';
      let uploaderName = evt.operator_name || '';
      if (!uploaderUsername && evt.operator) {
        const match = String(evt.operator).match(/\(([^)]+)\)/);
        if (match) uploaderUsername = match[1];
        else uploaderUsername = evt.operator;
        uploaderName = evt.operator;
      }
      files.forEach((f, idx) => {
        const imgId = f.id || `${evt.event_id}_img_${idx}`;
        images.push({
          id: imgId,
          filename: f.filename || `image_${idx}.jpg`,
          url: f.url,
          timestamp: f.timestamp || evt.timestamp || evt.created_at,
          uploader_username: f.uploader_username || uploaderUsername || 'operator',
          uploader_name: f.uploader_name || uploaderName || '操作员',
          description: f.description !== undefined ? f.description : (payload.description || ''),
          location: f.location || payload.location || '',
          longitude: f.longitude !== undefined ? f.longitude : (payload.longitude !== undefined ? payload.longitude : null),
          latitude: f.latitude !== undefined ? f.latitude : (payload.latitude !== undefined ? payload.latitude : null),
          person_name: payload.person_name || '',
          event_id: evt.event_id,
          task_code: evt.task_code,
          task_name: evt.task_name
        });
      });
    });

    // 严格按时间顺序 (Chronological Time Order) 排序
    images.sort((a, b) => {
      const timeA = new Date(a.timestamp).getTime() || 0;
      const timeB = new Date(b.timestamp).getTime() || 0;
      return sortOrder.toUpperCase() === 'DESC' ? timeB - timeA : timeA - timeB;
    });

    return images;
  }

  // 修改图片信息 (描述、地点、拍摄时间)
  async updateImageMetadata(imageId, updates = {}) {
    const allEvents = await this.getEvents(null, { limit: 100000 });
    let targetEvent = null;
    let targetFileIdx = -1;

    for (const evt of allEvents) {
      const files = evt.files || [];
      const idx = files.findIndex((f, i) => (f.id || `${evt.event_id}_img_${i}`) === imageId);
      if (idx >= 0) {
        targetEvent = evt;
        targetFileIdx = idx;
        break;
      }
    }

    if (!targetEvent || targetFileIdx < 0) return null;

    const files = [...targetEvent.files];
    const originalFile = files[targetFileIdx];
    const updatedFile = {
      ...originalFile,
      id: originalFile.id || imageId,
      description: updates.description !== undefined ? updates.description : (originalFile.description || ''),
      location: updates.location !== undefined ? updates.location : (originalFile.location || ''),
      timestamp: updates.timestamp || originalFile.timestamp || targetEvent.timestamp
    };
    files[targetFileIdx] = updatedFile;

    targetEvent.files = files;
    await this.saveEvent(targetEvent);
    return updatedFile;
  }

  // 删除单据事件记录
  deleteEvent(eventId) {
    if (!eventId) return Promise.resolve(false);
    if (this.isNative && this.db) {
      const operation = () => new Promise((resolve, reject) => {
        this.db.run('DELETE FROM events WHERE event_id = ?', [eventId], function(err) {
          if (err) return reject(err);
          resolve(this.changes > 0);
        });
      });
      this.pendingWrites = this.pendingWrites.catch(() => {}).then(operation);
      return this.pendingWrites;
    }
    try {
      const eventJsonPath = `${this.dbPath}.fallback.json`;
      if (fs.existsSync(eventJsonPath)) {
        let events = this.getAllFallbackEvents();
        const beforeLen = events.length;
        events = events.filter(event => event.event_id !== eventId);
        this.writeFallback(eventJsonPath, events);
        return Promise.resolve(events.length < beforeLen);
      }
    } catch (e) { return Promise.reject(e); }
    return Promise.resolve(false);
  }

  // 删除图片及关联单据/点位信息
  async deleteImage(imageId) {
    const allEvents = await this.getEvents(null, { limit: 100000 });
    let targetEvent = null;
    let deletedFile = null;

    for (const evt of allEvents) {
      const files = evt.files || [];
      const idx = files.findIndex((f, i) => (f.id || `${evt.event_id}_img_${i}`) === imageId);
      if (idx >= 0) {
        deletedFile = files[idx];
        files.splice(idx, 1);
        targetEvent = evt;
        targetEvent.files = files;
        break;
      }
    }

    if (!targetEvent) return false;

    // 如果事件下的所有图片均已删除，则直接将该单据事件/点位数据彻底删除
    if (!targetEvent.files || targetEvent.files.length === 0) {
      await this.deleteEvent(targetEvent.event_id);
    } else {
      await this.saveEvent(targetEvent);
    }

    // 清理磁盘上的物理文件与事件目录
    try {
      if (deletedFile && deletedFile.url) {
        const urlPath = deletedFile.url.replace(/^\/(?:collector-assets|assets)\//, '');
        const storageDir = path.dirname(this.dbPath);
        const candidates = [
          path.join(storageDir, 'collector_assets', urlPath),
          path.join(storageDir, 'assets', urlPath),
          path.join(storageDir, 'collector_assets', String(targetEvent.event_id), deletedFile.filename || ''),
          path.join(storageDir, 'assets', String(targetEvent.event_id), deletedFile.filename || '')
        ];
        for (const filePath of candidates) {
          if (fs.existsSync(filePath)) {
            try { fs.unlinkSync(filePath); } catch (e) {}
          }
        }
        const eventDirs = [
          path.join(storageDir, 'collector_assets', String(targetEvent.event_id)),
          path.join(storageDir, 'assets', String(targetEvent.event_id))
        ];
        for (const dirPath of eventDirs) {
          if (fs.existsSync(dirPath)) {
            try {
              const remaining = fs.readdirSync(dirPath);
              if (remaining.length === 0) fs.rmdirSync(dirPath);
            } catch (e) {}
          }
        }
      }
    } catch (e) {}

    return true;
  }

  close() {
    if (!this.db) return Promise.resolve();
    return new Promise((resolve, reject) => this.db.close(err => err ? reject(err) : resolve()));
  }
}

module.exports = SQLiteStorageEngine;
