const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const { md5String, md5File } = require('./checksum');
const { createInfoJson, signInfoObject } = require('./protocol');
const { isSafeIdentifier, isSafeFileName, resolveInside, getImageExtension, validateImageMagic } = require('./security_utils');

/**
 * 通用单据打包引擎 (.tmp 原子写入模式 + HMAC 签名 + 动态 Schema 嵌入)
 */
async function packEventPackage(options) {
  const {
    outputDir,
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
    files = [],
    schema = null
  } = options;

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  if (!isSafeIdentifier(appId) || !isSafeIdentifier(bizType) || !isSafeIdentifier(eventId) || !isSafeIdentifier(taskCode || 'TASK_DEFAULT')) {
    throw new Error('事件编号或任务编号格式无效');
  }
  if (!Array.isArray(files) || files.length > 200) throw new Error('附件数量超过限制');

  const pkgName = `vfusion_pkg_${eventId}`;
  const finalZipPath = resolveInside(outputDir, `${pkgName}.zip`);
  const tmpZipPath = `${finalZipPath}.tmp_${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  if (fs.existsSync(finalZipPath)) throw new Error(`数据包已存在: ${pkgName}`);

  const processedFiles = [];
  const fileChecksumMap = {};

  for (const f of files) {
    if (!f || !isSafeFileName(f.filename) || !fs.existsSync(f.path) || !fs.statSync(f.path).isFile()) {
      throw new Error(`附件文件无效: ${f && f.filename ? f.filename : 'unknown'}`);
    }
    const ext = getImageExtension(f.filename);
    if (!ext || !validateImageMagic(f.path, ext)) throw new Error(`附件图片内容无效: ${f.filename}`);
    const fileMd5 = await md5File(f.path);
    processedFiles.push({
      filename: f.filename,
      file_type: 'image',
      sha256: fileMd5
    });
    fileChecksumMap[`images/${f.filename}`] = fileMd5;
  }

  const infoData = createInfoJson({
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
    files: processedFiles
  });

  // 如果携带了动态 Schema 定义，则写入单据负荷
  if (schema) {
    infoData.schema_definition = schema;
  }

  // 所有字段就位后再签名，并将签名回填进 info.json，
  // 保证接收端能对 info.json 自身做完整性与真实性校验
  const { signedInfo, signature: sigContent, infoJsonStr } = signInfoObject(infoData);

  const infoJsonMd5 = md5String(infoJsonStr);
  fileChecksumMap['info.json'] = infoJsonMd5;

  const sigMd5 = md5String(sigContent);
  fileChecksumMap['signature.sig'] = sigMd5;

  let checksumLines = [];
  for (const [filename, hash] of Object.entries(fileChecksumMap)) {
    checksumLines.push(`${hash}  ${filename}`);
  }
  const checksumContent = checksumLines.join('\n');

  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(tmpZipPath);
    const archive = archiver('zip', { zlib: { level: 1 } });

    output.on('close', () => {
      fs.rename(tmpZipPath, finalZipPath, (err) => {
        if (err) return reject(err);
        resolve({
          pkgName,
          zipPath: finalZipPath,
          size: archive.pointer(),
          info: signedInfo
        });
      });
    });

    output.on('error', reject);
    archive.on('error', (err) => reject(err));
    archive.pipe(output);

    archive.append(infoJsonStr, { name: 'info.json' });
    archive.append(checksumContent, { name: 'checksum.txt' });
    archive.append(sigContent, { name: 'signature.sig' });

    for (const f of files) {
      archive.file(f.path, { name: `images/${f.filename}` });
    }

    archive.finalize();
  });
}

module.exports = {
  packEventPackage
};
