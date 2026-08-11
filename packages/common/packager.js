const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const { md5String, md5File } = require('./checksum');
const { createInfoJson, calculateHmacSignature } = require('./protocol');

/**
 * 通用单据打包引擎 (.tmp 原子写入模式 + HMAC 签名 + 动态 Schema 嵌入)
 */
async function packEventPackage(options) {
  const {
    outputDir,
    appId,
    bizType,
    eventId,
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

  const pkgName = `vfusion_pkg_${eventId}`;
  const finalZipPath = path.join(outputDir, `${pkgName}.zip`);
  const tmpZipPath = path.join(outputDir, `${pkgName}.zip.tmp`);

  const processedFiles = [];
  const fileChecksumMap = {};

  for (const f of files) {
    const fileMd5 = await md5File(f.path);
    processedFiles.push({
      filename: f.filename,
      file_type: 'image',
      md5: fileMd5
    });
    fileChecksumMap[`images/${f.filename}`] = fileMd5;
  }

  const infoData = createInfoJson({
    appId,
    bizType,
    eventId,
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

  const infoJsonStr = JSON.stringify(infoData, null, 2);
  const infoJsonMd5 = md5String(infoJsonStr);
  fileChecksumMap['info.json'] = infoJsonMd5;

  const sigContent = calculateHmacSignature(infoJsonStr);
  const sigMd5 = md5String(sigContent);
  fileChecksumMap['signature.sig'] = sigMd5;

  let checksumLines = [];
  for (const [filename, hash] of Object.entries(fileChecksumMap)) {
    checksumLines.push(`${hash}  ${filename}`);
  }
  const checksumContent = checksumLines.join('\n');

  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(tmpZipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => {
      fs.rename(tmpZipPath, finalZipPath, (err) => {
        if (err) return reject(err);
        resolve({
          pkgName,
          zipPath: finalZipPath,
          size: archive.pointer(),
          info: infoData
        });
      });
    });

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
