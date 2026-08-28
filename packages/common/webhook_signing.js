const crypto = require('crypto');

const WEBHOOK_SIGNATURE_HEADER = 'X-VFusion-Signature';
const WEBHOOK_SECRET_BYTES = 32;

function generateWebhookSecret() {
  return crypto.randomBytes(WEBHOOK_SECRET_BYTES).toString('hex');
}

function signWebhookPayload(payload, secret) {
  if (typeof secret !== 'string' || secret.length < WEBHOOK_SECRET_BYTES) throw new Error('Webhook 签名密钥长度不足');
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

function verifyWebhookSignature(payload, signature, secret) {
  if (typeof signature !== 'string' || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  let expected;
  try { expected = signWebhookPayload(payload, secret); } catch (e) { return false; }
  const actualBuffer = Buffer.from(signature, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

module.exports = {
  WEBHOOK_SIGNATURE_HEADER,
  generateWebhookSecret,
  signWebhookPayload,
  verifyWebhookSignature
};
