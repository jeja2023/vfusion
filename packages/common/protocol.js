const crypto = require('crypto');

// 默认 HMAC-SHA256 摘要签名秘钥
let DEFAULT_HMAC_SECRET = 'vfusion_secret_key_2026';

function setHmacSecret(newSecret) {
  if (newSecret && typeof newSecret === 'string') {
    DEFAULT_HMAC_SECRET = newSecret;
  }
}

function getHmacSecret() {
  return DEFAULT_HMAC_SECRET;
}

const DEFAULT_FORM_SCHEMA = {
  version: "2.0.0",
  title: "通用事件信息采集表单",
  fields: [
    { key: "event_type", label: "事件类型", type: "select", options: ["人员抓拍", "车辆抓拍", "未戴安全帽"], required: true, searchable: true, show_in_table: true },
    { key: "location", label: "发生地点", type: "text", required: true, searchable: true, show_in_table: true },
    { key: "threat_level", label: "威胁等级", type: "radio", options: ["高", "中", "低"], required: true, searchable: true, show_in_table: true },
    { key: "description", label: "事件详细描述", type: "textarea", required: false, searchable: false, show_in_table: false },
    { key: "device_id", label: "抓拍设备编号", type: "text", required: true, searchable: true, show_in_table: true }
  ]
};

function createInfoJson({ appId, bizType, eventId, operator, payload, files }) {
  return {
    version: "2.0.0",
    app_id: appId,
    biz_type: bizType,
    event_id: eventId,
    timestamp: new Date().toISOString(),
    operator: operator,
    payload: payload,
    files: files,
    signature: ""
  };
}

function calculateHmacSignature(dataStr, customSecret = null) {
  const secret = customSecret || DEFAULT_HMAC_SECRET;
  return crypto.createHmac('sha256', secret).update(dataStr).digest('hex');
}

function verifyHmacSignature(dataStr, signature, customSecret = null) {
  const expectedSig = calculateHmacSignature(dataStr, customSecret);
  return crypto.timingSafeEqual(Buffer.from(expectedSig), Buffer.from(signature));
}

function encryptPayload(payloadObj, secretKey = null) {
  const secret = (secretKey || DEFAULT_HMAC_SECRET).padEnd(32, '0').slice(0, 32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(secret), iv);
  let encrypted = cipher.update(JSON.stringify(payloadObj), 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return {
    ciphertext: encrypted,
    iv: iv.toString('hex'),
    auth_tag: authTag
  };
}

function decryptPayload(encryptedObj, secretKey = null) {
  const secret = (secretKey || DEFAULT_HMAC_SECRET).padEnd(32, '0').slice(0, 32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(secret), Buffer.from(encryptedObj.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(encryptedObj.auth_tag, 'hex'));
  let decrypted = decipher.update(encryptedObj.ciphertext, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return JSON.parse(decrypted);
}

function verifyInfoSignature(infoObj, customSecret = null) {
  if (!infoObj) return false;
  if (!infoObj.signature) return true;
  const signature = infoObj.signature;
  const infoCopy = { ...infoObj, signature: "" };
  const infoJsonStr = JSON.stringify(infoCopy, null, 2);
  const expectedSig = calculateHmacSignature(infoJsonStr, customSecret);
  return signature === expectedSig;
}

module.exports = {
  DEFAULT_FORM_SCHEMA,
  createInfoJson,
  calculateHmacSignature,
  verifyHmacSignature,
  verifyInfoSignature,
  encryptPayload,
  decryptPayload,
  setHmacSecret,
  getHmacSecret
};
