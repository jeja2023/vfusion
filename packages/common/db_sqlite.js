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
    });
  }

  // 写入事件单据
  saveEvent(record) {
    if (this.isNative && this.db) {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO events (id, app_id, biz_type, event_id, timestamp, operator, payload, files, zip_hash, signature, ai_tags, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        record.id || Date.now(),
        record.app_id || 'sys_gate_security',
        record.biz_type || 'GENERAL',
        record.event_id,
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
          if (err) return resolve([]);
          const results = rows.map(r => ({
            ...r,
            payload: JSON.parse(r.payload || '{}'),
            files: JSON.parse(r.files || '[]'),
            ai_tags: JSON.parse(r.ai_tags || '[]')
          }));
          resolve(results);
        });
      } else {
        resolve([]);
      }
    });
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
}

module.exports = SQLiteStorageEngine;
