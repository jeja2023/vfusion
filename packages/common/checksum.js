const crypto = require('crypto');
const fs = require('fs');

/**
 * 计算字符串的 SHA-256
 */
function sha256String(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

/**
 * 计算文件的 SHA-256
 */
function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', data => hash.update(data));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', err => reject(err));
  });
}

function md5StringLegacy(str) {
  return crypto.createHash('md5').update(str, 'utf8').digest('hex');
}

function md5FileLegacy(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5');
    const stream = fs.createReadStream(filePath);
    stream.on('data', data => hash.update(data));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

module.exports = {
  md5String: sha256String,
  md5File: sha256File,
  sha256String,
  sha256File,
  md5StringLegacy,
  md5FileLegacy
};
