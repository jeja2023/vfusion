const fs = require('fs');
const net = require('net');
const dns = require('dns').promises;
const path = require('path');

const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);

function isSafeIdentifier(value) {
  return typeof value === 'string' && IDENTIFIER_RE.test(value);
}

function isSafeFileName(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 255 &&
    value !== '.' && value !== '..' && !value.includes('/') &&
    !value.includes('\\') && !value.includes('\0');
}

function resolveInside(rootDir, ...parts) {
  const root = path.resolve(rootDir);
  const candidate = path.resolve(root, ...parts);
  if (candidate !== root && !candidate.startsWith(root + path.sep)) {
    throw new Error('路径超出允许的存储目录');
  }
  return candidate;
}

function getImageExtension(originalFilename, mimeType = '') {
  const ext = path.extname(String(originalFilename || '')).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(ext)) return null;
  const allowedMime = !mimeType || /^image\/(jpeg|png|gif|webp|bmp)$/i.test(mimeType);
  return allowedMime ? ext : null;
}

function isPrivateAddress(address) {
  const normalized = String(address || '').toLowerCase().replace(/^\[|\]$/g, '');
  const version = net.isIP(normalized);
  if (version === 4) {
    const octets = normalized.split('.').map(Number);
    const [a, b] = octets;
    return a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 2) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0) ||
      a >= 224;
  }
  if (version === 6) {
    if (normalized === '::' || normalized === '::1') return true;
    if (normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) return true;
    if (normalized.startsWith('::ffff:')) return isPrivateAddress(normalized.slice(7));
  }
  return false;
}

function isCloudMetadataAddress(address) {
  const normalized = String(address || '').toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === '169.254.169.254' || normalized === 'metadata.google.internal';
}

function validateHttpUrl(value, options = {}) {
  const allowPrivate = options.allowPrivate !== false; // 视汇作为内网/专网数据中台，默认允许分发至内网与本机系统
  let parsed;
  try { parsed = new URL(value); } catch (e) { return { valid: false, error: 'URL 格式无效' }; }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    return { valid: false, error: '仅允许不带凭据的 HTTP/HTTPS URL' };
  }
  const hostname = parsed.hostname.toLowerCase().replace(/[\[\]]/g, '');
  if (isCloudMetadataAddress(hostname)) {
    return { valid: false, error: '禁止访问云元数据服务地址' };
  }
  const ipVersion = net.isIP(hostname);
  if (!allowPrivate && ((ipVersion && isPrivateAddress(hostname)) || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local'))) {
    return { valid: false, error: '禁止访问本机、内网或链路本地地址' };
  }
  return { valid: true, url: parsed };
}

async function validateHttpUrlResolved(value, options = {}) {
  const allowPrivate = options.allowPrivate !== false;
  const result = validateHttpUrl(value, options);
  if (!result.valid) return result;
  const hostname = result.url.hostname.replace(/[\[\]]/g, '');
  const literalFamily = net.isIP(hostname);
  if (literalFamily) return { ...result, addresses: [{ address: hostname, family: literalFamily }] };
  if (hostname === 'localhost') {
    return { ...result, addresses: [{ address: '127.0.0.1', family: 4 }] };
  }
  try {
    const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
    if (!addresses.length) {
      return { valid: false, error: '目标域名解析失败，未找到可用 IP' };
    }
    if (addresses.some(record => isCloudMetadataAddress(record.address))) {
      return { valid: false, error: '禁止访问解析到云元数据服务地址的目标' };
    }
    if (!allowPrivate && addresses.some(record => isPrivateAddress(record.address))) {
      return { valid: false, error: '禁止访问解析到内网或链路本地地址的目标' };
    }
    return { ...result, addresses };
  } catch (e) {
    if (hostname === 'localhost' || hostname === '127.0.0.1') {
      return { ...result, addresses: [{ address: '127.0.0.1', family: 4 }] };
    }
    return { valid: false, error: `目标域名解析失败: ${e.message}` };
  }
}

function assertJsonObject(value, label = '对象') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}格式无效`);
  }
  return value;
}

function validateImageMagic(filePath, extension) {
  const header = Buffer.alloc(12);
  const fd = fs.openSync(filePath, 'r');
  try { fs.readSync(fd, header, 0, header.length, 0); } finally { fs.closeSync(fd); }
  if (extension === '.jpg' || extension === '.jpeg') return header[0] === 0xff && header[1] === 0xd8;
  if (extension === '.png') return header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (extension === '.gif') return header.subarray(0, 6).toString('ascii') === 'GIF87a' || header.subarray(0, 6).toString('ascii') === 'GIF89a';
  if (extension === '.webp') return header.subarray(0, 4).toString('ascii') === 'RIFF' && header.subarray(8, 12).toString('ascii') === 'WEBP';
  if (extension === '.bmp') return header.subarray(0, 2).toString('ascii') === 'BM';
  return false;
}

module.exports = {
  isSafeIdentifier,
  isSafeFileName,
  resolveInside,
  getImageExtension,
  validateHttpUrl,
  validateHttpUrlResolved,
  isPrivateAddress,
  assertJsonObject,
  validateImageMagic
};
