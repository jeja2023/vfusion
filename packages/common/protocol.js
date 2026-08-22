const crypto = require('crypto');

// 默认 HMAC-SHA256 摘要签名秘钥
let DEFAULT_HMAC_SECRET = crypto.randomBytes(32).toString('hex');

function setHmacSecret(newSecret) {
  if (newSecret && typeof newSecret === 'string' && newSecret.length >= 32) {
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
    { key: "event_time", label: "事件时间", type: "text", required: true, searchable: true, show_in_table: true },
    { key: "transportation", label: "交通方式", type: "select", options: ["步行", "自行车/电动车", "小型客车", "大型客车", "货车", "轨道交通", "水路/航空", "其他"], required: true, searchable: true, show_in_table: true },
    { key: "location", label: "地点", type: "text", required: true, searchable: true, show_in_table: true },
    { key: "longitude", label: "经度", type: "text", required: false, searchable: true, show_in_table: true },
    { key: "latitude", label: "纬度", type: "text", required: false, searchable: true, show_in_table: true },
    { key: "description", label: "事件描述", type: "textarea", required: false, searchable: false, show_in_table: false },
    { key: "person_name", label: "涉事人员姓名", type: "text", required: false, searchable: true, show_in_table: true },
    { key: "person_id_card", label: "涉事人员身份证号码", type: "text", required: false, searchable: true, show_in_table: true },
    { key: "person_domicile", label: "涉事人员户籍地址", type: "text", required: false, searchable: false, show_in_table: false }
  ]
};

function createInfoJson({ appId, bizType, eventId, taskName, taskCode, operator, operatorUsername, operatorName, submitTime, payload, files }) {
  const nowStr = submitTime || new Date().toISOString();
  return {
    version: "2.0.0",
    app_id: appId,
    biz_type: bizType,
    event_id: eventId,
    task_name: taskName || '厂区周界安防例行巡检',
    task_code: taskCode || 'TASK_DEFAULT',
    timestamp: nowStr,
    submit_time: nowStr,
    operator: operator || `${operatorName || '操作员'} (${operatorUsername || 'operator'})`,
    operator_username: operatorUsername || 'operator',
    operator_name: operatorName || '操作员',
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
  if (typeof signature !== 'string' || signature.length === 0) return false;
  const expectedSig = calculateHmacSignature(dataStr, customSecret);
  const expectedBuf = Buffer.from(expectedSig, 'utf8');
  const actualBuf = Buffer.from(signature, 'utf8');
  // timingSafeEqual 要求两个 Buffer 等长，长度不一致时直接判定失败
  if (expectedBuf.length !== actualBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, actualBuf);
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

/**
 * 计算 info 对象的规范化签名
 * 约定：签名始终基于 signature 字段置空后的 JSON 文本计算，保证签发与校验两端一致
 */
function serializeInfoForSigning(infoObj) {
  const infoCopy = { ...infoObj, signature: "" };
  return JSON.stringify(infoCopy, null, 2);
}

/**
 * 对 info 对象签名并回填 signature 字段，返回最终用于写入 info.json 的对象与文本
 */
function signInfoObject(infoObj, customSecret = null) {
  const signature = calculateHmacSignature(serializeInfoForSigning(infoObj), customSecret);
  const signedInfo = { ...infoObj, signature };
  return { signedInfo, signature, infoJsonStr: JSON.stringify(signedInfo, null, 2) };
}

function verifyInfoSignature(infoObj, customSecret = null) {
  if (!infoObj) return false;
  // 缺失或空签名一律视为校验失败，不得放行未签名的数据包
  if (typeof infoObj.signature !== 'string' || infoObj.signature.length === 0) return false;
  return verifyHmacSignature(serializeInfoForSigning(infoObj), infoObj.signature, customSecret);
}

module.exports = {
  DEFAULT_FORM_SCHEMA,
  createInfoJson,
  calculateHmacSignature,
  verifyHmacSignature,
  verifyInfoSignature,
  signInfoObject,
  serializeInfoForSigning,
  encryptPayload,
  decryptPayload,
  setHmacSecret,
  getHmacSecret
};
