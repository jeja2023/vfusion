const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  isSafeIdentifier,
  isSafeFileName,
  resolveInside,
  validateHttpUrl,
  validateHttpUrlResolved,
  getImageExtension
} = require('./security_utils');
const { normalizeCoordinates, normalizeMonitoringPoint, findMonitoringPoint, applyMonitoringPoint } = require('./monitoring_points');
const { writeJsonAtomic, readJson } = require('./json_store');
const { generateToken, verifyToken, setTokenSecret } = require('./auth_middleware');
const { generateWebhookSecret, signWebhookPayload, verifyWebhookSignature, WEBHOOK_SIGNATURE_HEADER } = require('./webhook_signing');

let passed = 0;
let failed = 0;
function check(name, condition) {
  if (condition) { console.log(`  [PASS] ${name}`); passed++; }
  else { console.error(`  [FAIL] ${name}`); failed++; }
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vfusion-security-'));
try {
  console.log('=== VFusion 安全工具与原子存储测试 ===');
  check('安全标识符允许业务编号', isSafeIdentifier('TASK_2026-001'));
  check('安全标识符拒绝路径穿越', !isSafeIdentifier('../etc/passwd'));
  check('安全文件名拒绝目录分隔符', !isSafeFileName('../secret.jpg'));
  check('图片扩展名白名单生效', getImageExtension('snapshot.JPG', 'image/jpeg') === '.jpg');
  check('图片扩展名拒绝脚本', getImageExtension('payload.svg', 'image/svg+xml') === null);
  check('Webhook 拒绝本机地址', !validateHttpUrl('http://127.0.0.1:8080/hook').valid);
  check('Webhook 接受公网 HTTPS', validateHttpUrl('https://example.com/hook').valid);
  check('经纬度范围校验并规范化', JSON.stringify(normalizeCoordinates('116.3971284', '39.9165278')) === JSON.stringify({ longitude: 116.3971284, latitude: 39.9165278 }));
  let invalidCoordinatesRejected = false;
  try { normalizeCoordinates('181', '39'); } catch (e) { invalidCoordinatesRejected = true; }
  check('非法经纬度被拒绝', invalidCoordinatesRejected);
  const point = normalizeMonitoringPoint({ point_id: 'GATE_NORTH_01', name: '北门1号机', location: '厂区北门', longitude: '116.3971284', latitude: '39.9165278' });
  check('监控点位可规范化', point.point_id === 'GATE_NORTH_01' && point.longitude === 116.3971284 && point.latitude === 39.9165278);
  const pointWithoutCoordinates = normalizeMonitoringPoint({ point_id: 'GATE_UNKNOWN_01', name: '待测点位', location: '待测区域' });
  check('点位经纬度可选', pointWithoutCoordinates.longitude === null && pointWithoutCoordinates.latitude === null);
  check('停用点位不会被默认选择', findMonitoringPoint([{ ...point, enabled: false }], point.point_id) === null);
  const payload = {};
  applyMonitoringPoint(payload, point);
  check('点位选择会覆盖地点与坐标', payload.location === '厂区北门' && payload.longitude === point.longitude && payload.location_source === 'MONITORING_POINT');
  const inside = resolveInside(tempDir, 'nested', 'file.json');
  check('目录解析保持在根目录内', inside.startsWith(path.resolve(tempDir)));
  const jsonPath = path.join(tempDir, 'state.json');
  writeJsonAtomic(jsonPath, { ok: true, count: 1 });
  check('原子 JSON 写入可读', readJson(jsonPath, {}).count === 1);
  setTokenSecret('test_token_secret_012345678901234567890123');
  const apiToken = generateToken({ id: 1, username: 'tester', role: 'operator' }, { audience: 'test-service' });
  const assetToken = generateToken({ id: 1, username: 'tester', role: 'operator' }, { audience: 'test-service', scope: 'asset', ttlMs: 10000 });
  check('API Token audience 校验生效', Boolean(verifyToken(apiToken, { audience: 'test-service' })));
  check('资产 Token scope 校验生效', Boolean(verifyToken(assetToken, { audience: 'test-service', allowedScopes: ['asset'] })));
  check('API 中间件拒绝资产 Token', verifyToken(assetToken, { audience: 'test-service', allowedScopes: ['api'] }) === null);
  const webhookSecret = generateWebhookSecret();
  const webhookBody = JSON.stringify({ event: 'EVENT_INGESTED', data: { id: 1 } });
  const webhookSignature = signWebhookPayload(webhookBody, webhookSecret);
  check('Webhook 使用独立随机密钥签名', webhookSecret.length === 64 && WEBHOOK_SIGNATURE_HEADER === 'X-VFusion-Signature');
  check('Webhook 签名可验证', verifyWebhookSignature(webhookBody, webhookSignature, webhookSecret));
  check('数据包密钥不能验证 Webhook 签名', !verifyWebhookSignature(webhookBody, webhookSignature, 'different-package-secret-012345678901234567'));
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

validateHttpUrlResolved('https://8.8.8.8/hook').then(result => {
  check('公网 IP Webhook 解析校验可执行', result.valid === true);
  console.log(`=== 测试结果: ${passed} 通过, ${failed} 失败 ===`);
  if (failed) process.exit(1);
}).catch(err => {
  console.error('Webhook 解析测试异常:', err);
  process.exit(1);
});
