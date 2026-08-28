const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const unzipper = require('unzipper');
const { md5String, md5File, md5StringLegacy, md5FileLegacy } = require('./checksum');
const { verifyInfoSignature } = require('./protocol');
const { isSafeFileName, isSafeIdentifier, resolveInside, getImageExtension, validateImageMagic } = require('./security_utils');

const MAX_PACKAGE_BYTES = 200 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 500 * 1024 * 1024;
const MAX_ENTRIES = 300;

function fail(message) { throw new Error(`解包校验失败: ${message}`); }

async function inspectArchive(zipFilePath) {
  const stat = fs.statSync(zipFilePath);
  if (!stat.isFile() || stat.size > MAX_PACKAGE_BYTES) fail('压缩包超过 200MB 大小限制');
  const directory = await unzipper.Open.file(zipFilePath);
  if (directory.files.length > MAX_ENTRIES) fail('压缩包条目数量超过限制');
  let total = 0;
  for (const entry of directory.files) {
    const entryPath = String(entry.path || '').replace(/\\/g, '/');
    if (!entryPath || entryPath.startsWith('/') || entryPath.split('/').includes('..')) fail(`压缩包包含非法路径: ${entryPath}`);
    const size = Number(entry.uncompressedSize || 0);
    total += Number.isFinite(size) ? size : 0;
    if (total > MAX_UNCOMPRESSED_BYTES) fail('压缩包解压后超过 500MB 限制');
    if (entry.type === 'SymbolicLink' || entry.type === 'Link') fail('压缩包不允许包含符号链接');
    if (entryPath !== 'info.json' && entryPath !== 'checksum.txt' && entryPath !== 'signature.sig' && entryPath !== 'images/' && !entryPath.startsWith('images/')) {
      fail(`压缩包包含未允许的条目: ${entryPath}`);
    }
    if (entryPath.startsWith('images/') && entryPath !== 'images/' && !isSafeFileName(entryPath.slice('images/'.length))) {
      fail(`图片文件名无效: ${entryPath}`);
    }
  }
}

async function unpackAndVerifyPackage(zipFilePath, targetDir) {
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
  const zipFileHash = await md5File(zipFilePath);
  await inspectArchive(zipFilePath);

    const extractDir = resolveInside(targetDir, `_tmp_${process.pid}_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`);
  fs.mkdirSync(extractDir, { recursive: true });
  let keepExtractDir = false;

  try {
    await fs.createReadStream(zipFilePath)
      .pipe(unzipper.Extract({ path: extractDir }))
      .promise();

    const infoJsonPath = resolveInside(extractDir, 'info.json');
    const checksumPath = resolveInside(extractDir, 'checksum.txt');
    const signaturePath = resolveInside(extractDir, 'signature.sig');
    if (!fs.existsSync(infoJsonPath) || !fs.existsSync(checksumPath) || !fs.existsSync(signaturePath)) {
      fail('缺少必要的 info.json、checksum.txt 或 signature.sig');
    }

    let infoJsonContent;
    try { infoJsonContent = JSON.parse(fs.readFileSync(infoJsonPath, 'utf8')); } catch (e) { fail('info.json 不是合法 JSON'); }
    if (!infoJsonContent || typeof infoJsonContent !== 'object' || Array.isArray(infoJsonContent)) fail('info.json 格式无效');
    if (!isSafeIdentifier(infoJsonContent.event_id) || !isSafeIdentifier(infoJsonContent.task_code || 'TASK_DEFAULT')) fail('事件或任务标识无效');
    if (!Array.isArray(infoJsonContent.files) || infoJsonContent.files.length > 200) fail('附件清单无效');
    const listedImageNames = new Set();
    for (const file of infoJsonContent.files) {
      if (!file || !isSafeFileName(file.filename) || !/^(?:[a-f0-9]{64}|[a-f0-9]{32})$/i.test(String(file.sha256 || file.md5 || ''))) fail('附件清单字段无效');
      if (listedImageNames.has(file.filename)) fail(`附件清单存在重复文件名: ${file.filename}`);
      listedImageNames.add(file.filename);
      const imagePath = resolveInside(extractDir, 'images', file.filename);
      const ext = getImageExtension(file.filename);
      if (!ext || !fs.existsSync(imagePath) || !fs.statSync(imagePath).isFile() || !validateImageMagic(imagePath, ext)) fail(`附件图片内容无效: ${file.filename}`);
    }
    const imagesDir = resolveInside(extractDir, 'images');
    const actualImageNames = fs.existsSync(imagesDir) ? fs.readdirSync(imagesDir) : [];
    if (actualImageNames.length !== listedImageNames.size || actualImageNames.some(name => !listedImageNames.has(name) || !fs.statSync(resolveInside(imagesDir, name)).isFile())) {
      fail('图片目录与 info.json 附件清单不一致');
    }

    const checksumRaw = fs.readFileSync(checksumPath, 'utf8');
    const checksumLines = checksumRaw.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const entries = new Map();
    for (const line of checksumLines) {
      const match = line.match(/^([a-f0-9]{32}|[a-f0-9]{64})\s{2}(.+)$/i);
      if (!match) fail(`checksum.txt 条目格式无效: ${line}`);
      const expectedMd5 = match[1].toLowerCase();
      const relPath = match[2].replace(/\\/g, '/');
      if (entries.has(relPath)) fail(`checksum.txt 存在重复条目: ${relPath}`);
      if (relPath !== 'info.json' && relPath !== 'signature.sig' && !relPath.startsWith('images/')) fail(`checksum.txt 包含非法条目: ${relPath}`);
      if (relPath.startsWith('images/') && !isSafeFileName(relPath.slice('images/'.length))) fail(`checksum.txt 图片路径无效: ${relPath}`);
      const actualFilePath = resolveInside(extractDir, relPath);
      if (!fs.existsSync(actualFilePath) || !fs.statSync(actualFilePath).isFile()) fail(`文件丢失: ${relPath}`);
      const isLegacyMd5 = expectedMd5.length === 32;
      const actualMd5 = relPath === 'info.json' || relPath === 'signature.sig'
        ? (isLegacyMd5 ? md5StringLegacy(fs.readFileSync(actualFilePath, 'utf8')) : md5String(fs.readFileSync(actualFilePath, 'utf8')))
        : (isLegacyMd5 ? await md5FileLegacy(actualFilePath) : await md5File(actualFilePath));
      if (actualMd5.toLowerCase() !== expectedMd5) fail(`MD5 校验不一致: ${relPath}`);
      entries.set(relPath, expectedMd5);
    }

    const expectedEntries = new Set(['info.json', 'signature.sig', ...infoJsonContent.files.map(file => `images/${file.filename}`)]);
    if (entries.size !== expectedEntries.size || [...expectedEntries].some(entry => !entries.has(entry))) {
      fail('checksum.txt 未完整覆盖 info.json、签名和全部附件');
    }
    for (const file of infoJsonContent.files) {
      if (entries.get(`images/${file.filename}`) !== String(file.sha256 || file.md5).toLowerCase()) fail(`附件摘要与 info.json 不一致: ${file.filename}`);
    }
    const signatureContent = fs.readFileSync(signaturePath, 'utf8').trim();
    if (signatureContent !== infoJsonContent.signature) fail('signature.sig 与 info.json 签名不一致');
    if (!verifyInfoSignature(infoJsonContent)) fail('数字签名验证失败');

    keepExtractDir = true;
    return { zipFileHash, extractDir, info: infoJsonContent };
  } finally {
    if (!keepExtractDir) {
      try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch (e) {}
    }
  }
}

module.exports = { unpackAndVerifyPackage, MAX_PACKAGE_BYTES, MAX_UNCOMPRESSED_BYTES };
