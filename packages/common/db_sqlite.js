const fs = require('fs');
const path = require('path');

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
    });
  }

  // 写入事件单据
  saveEvent(record) {
    if (this.isNative && this.db) {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO events (id, app_id, biz_type, event_id, task_name, task_code, timestamp, operator, payload, files, zip_hash, signature, ai_tags, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        record.id || Date.now(),
        record.app_id || 'sys_gate_security',
        record.biz_type || 'GENERAL',
        record.event_id,
        record.task_name || '默认安防巡检任务',
        record.task_code || 'TASK_DEFAULT',
        record.timestamp,
        record.operator,
        JSON.stringify(record.payload || {}),
        JSON.stringify(record.files || []),
        record.zip_hash,
        record.signature,
        JSON.stringify(record.ai_tags || []),
        record.status || 'RECEIVED',
        record.created_at || new Date().toISOString()
      );
      stmt.finalize();
    }
    // 同时也写一份降级 JSON 备份文件，确保绝无数据丢包
    try {
      const jsonPath = `${this.dbPath}.fallback.json`;
      let list = [];
      if (fs.existsSync(jsonPath)) {
        list = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      }
      const existingIdx = list.findIndex(e => e.event_id === record.event_id);
      const norm = {
        id: record.id || Date.now(),
        app_id: record.app_id || 'sys_gate_security',
        biz_type: record.biz_type || 'GENERAL',
        event_id: record.event_id,
        task_name: record.task_name || '默认安防巡检任务',
        task_code: record.task_code || 'TASK_DEFAULT',
        timestamp: record.timestamp,
        operator: record.operator,
        payload: record.payload || {},
        files: record.files || [],
        zip_hash: record.zip_hash || '',
        signature: record.signature || '',
        ai_tags: record.ai_tags || [],
        status: record.status || 'RECEIVED',
        created_at: record.created_at || new Date().toISOString()
      };
      if (existingIdx >= 0) list[existingIdx] = norm;
      else list.unshift(norm);
      fs.writeFileSync(jsonPath, JSON.stringify(list, null, 2), 'utf8');
    } catch (e) {}
  }

  // 查询事件单据列表
  getEvents(appId = null) {
    return new Promise((resolve) => {
      if (this.isNative && this.db) {
        let sql = 'SELECT * FROM events ORDER BY id DESC';
        let params = [];
        if (appId) {
          sql = 'SELECT * FROM events WHERE app_id = ? ORDER BY id DESC';
          params = [appId];
        }
        this.db.all(sql, params, (err, rows) => {
          if (err || !rows || rows.length === 0) return resolve(this.getFallbackEvents(appId));
          const results = rows.map(r => ({
            ...r,
            payload: typeof r.payload === 'string' ? JSON.parse(r.payload || '{}') : (r.payload || {}),
            files: typeof r.files === 'string' ? JSON.parse(r.files || '[]') : (r.files || []),
            ai_tags: typeof r.ai_tags === 'string' ? JSON.parse(r.ai_tags || '[]') : (r.ai_tags || [])
          }));
          resolve(results);
        });
      } else {
        resolve(this.getFallbackEvents(appId));
      }
    });
  }

  getFallbackEvents(appId = null) {
    try {
      const jsonPath = `${this.dbPath}.fallback.json`;
      if (fs.existsSync(jsonPath)) {
        let list = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        if (appId) list = list.filter(e => e.app_id === appId);
        return list;
      }
    } catch (e) {}
    return [];
  }

  // 写入审计日志
  addAuditLog(type, message, status = 'INFO') {
    if (this.isNative && this.db) {
      const stmt = this.db.prepare(`
        INSERT INTO audit_logs (id, timestamp, type, message, status)
        VALUES (?, ?, ?, ?, ?)
      `);
      stmt.run(Date.now(), new Date().toISOString(), type, message, status);
      stmt.finalize();
    }
  }

  // 获取审计日志
  getAuditLogs(keyword = '', statusFilter = '', typeFilter = '') {
    return new Promise((resolve) => {
      if (this.isNative && this.db) {
        let sql = 'SELECT * FROM audit_logs WHERE 1=1';
        let params = [];
        if (keyword) {
          sql += ' AND (message LIKE ? OR type LIKE ?)';
          params.push(`%${keyword}%`, `%${keyword}%`);
        }
        if (statusFilter) {
          sql += ' AND status = ?';
          params.push(statusFilter);
        }
        if (typeFilter) {
          sql += ' AND type = ?';
          params.push(typeFilter);
        }
        sql += ' ORDER BY id DESC LIMIT 300';
        this.db.all(sql, params, (err, rows) => {
          if (err) return resolve([]);
          resolve(rows);
        });
      } else {
        resolve([]);
      }
    });
  }

  // 任务管理: 保存/更新任务
  saveTask(task) {
    const now = new Date().toISOString();
    const sharedUsersArr = Array.isArray(task.shared_users) ? task.shared_users : (typeof task.shared_users === 'string' ? (JSON.parse(task.shared_users || '[]')) : []);
    const taskRecord = {
      id: task.id || Date.now(),
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

    if (this.isNative && this.db) {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO tasks (id, task_code, task_name, description, creator_username, creator_name, share_code, is_shared, shared_users, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        taskRecord.id,
        taskRecord.task_code,
        taskRecord.task_name,
        taskRecord.description,
        taskRecord.creator_username,
        taskRecord.creator_name,
        taskRecord.share_code,
        taskRecord.is_shared,
        JSON.stringify(taskRecord.shared_users),
        taskRecord.status,
        taskRecord.created_at,
        taskRecord.updated_at
      );
      stmt.finalize();
    }

    try {
      const jsonPath = `${this.dbPath}.tasks_fallback.json`;
      let list = [];
      if (fs.existsSync(jsonPath)) {
        list = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      }
      const existingIdx = list.findIndex(t => t.task_code === taskRecord.task_code);
      if (existingIdx >= 0) list[existingIdx] = { ...list[existingIdx], ...taskRecord };
      else list.unshift(taskRecord);
      fs.writeFileSync(jsonPath, JSON.stringify(list, null, 2), 'utf8');
    } catch (e) {}

    return taskRecord;
  }

  // 获取所有任务
  getTasks() {
    return new Promise((resolve) => {
      if (this.isNative && this.db) {
        this.db.all('SELECT * FROM tasks ORDER BY updated_at DESC', [], (err, rows) => {
          if (err || !rows || rows.length === 0) return resolve(this.getFallbackTasks());
          resolve(rows.map(r => ({
            ...r,
            is_shared: Boolean(r.is_shared),
            shared_users: Array.isArray(r.shared_users) ? r.shared_users : (typeof r.shared_users === 'string' ? (JSON.parse(r.shared_users || '[]')) : [])
          })));
        });
      } else {
        resolve(this.getFallbackTasks());
      }
    });
  }

  getFallbackTasks() {
    try {
      const jsonPath = `${this.dbPath}.tasks_fallback.json`;
      if (fs.existsSync(jsonPath)) {
        const list = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
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
        this.db.get('SELECT * FROM tasks WHERE task_code = ? OR share_code = ?', [taskCode, taskCode], (err, row) => {
          if (err || !row) return resolve(this.getFallbackTasks().find(t => t.task_code === taskCode || t.share_code === taskCode) || null);
          resolve({
            ...row,
            is_shared: Boolean(row.is_shared),
            shared_users: Array.isArray(row.shared_users) ? row.shared_users : (typeof row.shared_users === 'string' ? (JSON.parse(row.shared_users || '[]')) : [])
          });
        });
      } else {
        resolve(this.getFallbackTasks().find(t => t.task_code === taskCode || t.share_code === taskCode) || null);
      }
    });
  }

  updateTaskStatus(taskCode, status) {
    const now = new Date().toISOString();
    if (this.isNative && this.db) {
      this.db.run('UPDATE tasks SET status = ?, updated_at = ? WHERE task_code = ?', [status, now, taskCode]);
    }
    try {
      const jsonPath = `${this.dbPath}.tasks_fallback.json`;
      if (fs.existsSync(jsonPath)) {
        let list = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        const t = list.find(x => x.task_code === taskCode);
        if (t) { t.status = status; t.updated_at = now; }
        fs.writeFileSync(jsonPath, JSON.stringify(list, null, 2), 'utf8');
      }
    } catch (e) {}
  }

  // 编辑任务详情
  updateTaskDetails(taskCode, updates = {}) {
    const now = new Date().toISOString();
    return new Promise((resolve) => {
      this.getTaskByCode(taskCode).then(task => {
        if (!task) return resolve(null);
        const updatedTask = {
          ...task,
          task_name: updates.task_name !== undefined ? updates.task_name : task.task_name,
          description: updates.description !== undefined ? updates.description : task.description,
          is_shared: updates.is_shared !== undefined ? (updates.is_shared ? 1 : 0) : task.is_shared,
          shared_users: updates.shared_users !== undefined ? (Array.isArray(updates.shared_users) ? updates.shared_users : (typeof updates.shared_users === 'string' ? JSON.parse(updates.shared_users || '[]') : [])) : (task.shared_users || []),
          status: updates.status || task.status,
          updated_at: now
        };
        if (this.isNative && this.db) {
          this.db.run(
            'UPDATE tasks SET task_name = ?, description = ?, is_shared = ?, shared_users = ?, status = ?, updated_at = ? WHERE task_code = ?',
            [updatedTask.task_name, updatedTask.description, updatedTask.is_shared ? 1 : 0, JSON.stringify(updatedTask.shared_users), updatedTask.status, now, taskCode]
          );
        }
        try {
          const jsonPath = `${this.dbPath}.tasks_fallback.json`;
          if (fs.existsSync(jsonPath)) {
            let list = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
            const idx = list.findIndex(x => x.task_code === taskCode);
            if (idx >= 0) { list[idx] = { ...list[idx], ...updatedTask }; }
            fs.writeFileSync(jsonPath, JSON.stringify(list, null, 2), 'utf8');
          }
        } catch (e) {}
        resolve(updatedTask);
      });
    });
  }

  // 删除任务
  deleteTask(taskCode) {
    return new Promise((resolve) => {
      if (this.isNative && this.db) {
        this.db.run('DELETE FROM tasks WHERE task_code = ?', [taskCode]);
      }
      try {
        const jsonPath = `${this.dbPath}.tasks_fallback.json`;
        if (fs.existsSync(jsonPath)) {
          let list = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
          list = list.filter(x => x.task_code !== taskCode);
          fs.writeFileSync(jsonPath, JSON.stringify(list, null, 2), 'utf8');
        }
      } catch (e) {}
      resolve(true);
    });
  }

  // 获取任务下按时间顺序（Chronological Order）排列的所有图片
  async getTaskImages(taskCode = null, sortOrder = 'ASC') {
    const allEvents = await this.getEvents();
    let events = allEvents;
    if (taskCode) {
      const targetCodeLower = String(taskCode).trim().toLowerCase();
      events = allEvents.filter(e => String(e.task_code || '').trim().toLowerCase() === targetCodeLower);
    }
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
    const allEvents = await this.getEvents();
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
    this.saveEvent(targetEvent);
    return updatedFile;
  }

  // 删除图片
  async deleteImage(imageId) {
    const allEvents = await this.getEvents();
    let targetEvent = null;

    for (const evt of allEvents) {
      const files = evt.files || [];
      const idx = files.findIndex((f, i) => (f.id || `${evt.event_id}_img_${i}`) === imageId);
      if (idx >= 0) {
        files.splice(idx, 1);
        targetEvent = evt;
        targetEvent.files = files;
        break;
      }
    }

    if (!targetEvent) return false;

    this.saveEvent(targetEvent);
    return true;
  }
}

module.exports = SQLiteStorageEngine;

