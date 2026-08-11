const fs = require('fs');
const path = require('path');
const unzipper = require('unzipper');
const { md5String, md5File } = require('./checksum');
const { verifyInfoSignature } = require('./protocol');

/**
 * 通用解包与 MD5 + HMAC 签名校验引擎
 */
async function unpackAndVerifyPackage(zipFilePath, targetDir) {
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  const zipFileHash = await md5File(zipFilePath);
  const extractDir = path.join(targetDir, `_tmp_${Date.now()}`);
  fs.mkdirSync(extractDir, { recursive: true });

  await fs.createReadStream(zipFilePath)
    .pipe(unzipper.Extract({ path: extractDir }))
    .promise();

  const infoJsonPath = path.join(extractDir, 'info.json');
  const checksumPath = path.join(extractDir, 'checksum.txt');

  if (!fs.existsSync(infoJsonPath) || !fs.existsSync(checksumPath)) {
    fs.rmSync(extractDir, { recursive: true, force: true });
    throw new Error('解包校验失败: 缺少必要的 info.json 或 checksum.txt');
  }

  // 1. 校验 checksum.txt
  const checksumRaw = fs.readFileSync(checksumPath, 'utf8');
  const checksumLines = checksumRaw.split(/\r?\n/).filter(line => line.trim().length > 0);

  for (const line of checksumLines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2) {
      const expectedMd5 = parts[0];
      const relPath = parts.slice(1).join(' ');
      const actualFilePath = path.join(extractDir, relPath);

      if (!fs.existsSync(actualFilePath)) {
        fs.rmSync(extractDir, { recursive: true, force: true });
        throw new Error(`文件丢失校验失败: ${relPath}`);
      }

      let actualMd5 = '';
      if (relPath === 'info.json' || relPath === 'signature.sig') {
        const fileStr = fs.readFileSync(actualFilePath, 'utf8');
        actualMd5 = md5String(fileStr);
      } else {
        actualMd5 = await md5File(actualFilePath);
      }

      if (actualMd5.toLowerCase() !== expectedMd5.toLowerCase()) {
        fs.rmSync(extractDir, { recursive: true, force: true });
        throw new Error(`MD5 校验不一致: ${relPath} (期望: ${expectedMd5}, 实际: ${actualMd5})`);
      }
    }
  }

  // 2. 解析 info.json 并验证 HMAC 数字签名
  const infoJsonContent = JSON.parse(fs.readFileSync(infoJsonPath, 'utf8'));
  const isSigValid = verifyInfoSignature(infoJsonContent);

  if (!isSigValid) {
    fs.rmSync(extractDir, { recursive: true, force: true });
    throw new Error('数字签名验证失败: 单据包内容被非法篡改或密钥不匹配');
  }

  return {
    zipFileHash,
    extractDir,
    info: infoJsonContent
  };
}

module.exports = {
  unpackAndVerifyPackage
};
