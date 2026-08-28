const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LOCK_WAIT_MS = 10;
const LOCK_TIMEOUT_MS = 5000;
const LOCK_STALE_MS = 30_000;

function waitSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireLock(filePath) {
  const lockPath = `${filePath}.lock`;
  const started = Date.now();
  while (Date.now() - started < LOCK_TIMEOUT_MS) {
    try { return { fd: fs.openSync(lockPath, 'wx'), lockPath }; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch (staleErr) {
        if (staleErr.code !== 'ENOENT') throw staleErr;
      }
      waitSync(LOCK_WAIT_MS);
    }
  }
  throw new Error(`获取文件锁超时: ${path.basename(filePath)}`);
}

function releaseLock(lock) {
  if (!lock) return;
  try { fs.closeSync(lock.fd); } catch (e) {}
  try { fs.unlinkSync(lock.lockPath); } catch (e) {}
}

function writeJsonAtomicUnlocked(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp_${process.pid}_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
  try {
    const fd = fs.openSync(tmpPath, 'w');
    try {
      fs.writeFileSync(fd, JSON.stringify(data, null, 2), 'utf8');
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(tmpPath, filePath);
  } finally {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (e) {}
  }
}

function writeJsonAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const lock = acquireLock(filePath);
  try { writeJsonAtomicUnlocked(filePath, data); }
  finally { releaseLock(lock); }
}

function readJson(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (e) { return fallback; }
}

function updateJsonAtomic(filePath, fallback, updater) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const lock = acquireLock(filePath);
  try {
    const current = readJson(filePath, fallback);
    const next = updater(current);
    writeJsonAtomicUnlocked(filePath, next);
    return next;
  } finally { releaseLock(lock); }
}

module.exports = { writeJsonAtomic, readJson, updateJsonAtomic };
