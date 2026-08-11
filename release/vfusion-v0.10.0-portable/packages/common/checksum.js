const crypto = require('crypto');
const fs = require('fs');

/**
 * 计算字符串的 MD5
 */
function md5String(str) {
  return crypto.createHash('md5').update(str, 'utf8').digest('hex');
}

/**
 * 计算文件的 MD5
 */
function md5File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5');
    const stream = fs.createReadStream(filePath);
    stream.on('data', data => hash.update(data));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', err => reject(err));
  });
}

module.exports = {
  md5String,
  md5File
};
