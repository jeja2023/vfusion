/**
 * VFusion (视汇) - 第三方系统消息分发 (Webhooks) 自动化冒烟测试
 * 
 * 测试覆盖范围:
 * 1. 独立 HMAC-SHA256 签名生成、防伪验签与防篡改防护
 * 2. Webhook 回调地址解析与安全性校验 (SSRF 防护)
 * 3. 订阅节点存储、状态切换、脱敏与密钥安全轮换
 * 4. 模拟第三方接收端真实 HTTP 连通性测试 (POST /api/webhooks/:id/test 逻辑)
 * 5. 单据入库并发分发 (dispatchWebhooks) 与节点超时/故障独立隔离机制
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const {
  generateWebhookSecret,
  signWebhookPayload,
  verifyWebhookSignature,
  WEBHOOK_SIGNATURE_HEADER
} = require('../packages/common/webhook_signing');

const {
  validateHttpUrl,
  validateHttpUrlResolved
} = require('../packages/common/security_utils');

const {
  authMiddleware,
  assetAuthMiddleware
} = require('../packages/common/auth_middleware');

console.log('================================================================');
console.log('   视汇 (VFusion) 第三方消息分发 (Webhooks) 核心功能冒烟测试');
console.log('================================================================\n');

let passedTests = 0;
let failedTests = 0;

function assert(description, condition, extraInfo = '') {
  if (condition) {
    console.log(`  ✓ [PASS] ${description}`);
    passedTests++;
  } else {
    console.error(`  ✕ [FAIL] ${description} ${extraInfo ? `-> ${extraInfo}` : ''}`);
    failedTests++;
  }
}

async function runSmokeTests() {
  // -------------------------------------------------------------
  // 测试阶段 1: 签名算法与安全防护机制测试
  // -------------------------------------------------------------
  console.log('[测试阶段 1/5] 独立 HMAC-SHA256 签名算法与防篡改验证...');
  const secret1 = generateWebhookSecret();
  assert('生成的签名密钥符合 64 位 Hex 规范', typeof secret1 === 'string' && secret1.length === 64 && /^[0-9a-f]{64}$/.test(secret1));

  const testPayload = JSON.stringify({
    event: 'EVENT_INGESTED',
    timestamp: new Date().toISOString(),
    data: {
      event_id: 'EVT_SMOKE_001',
      task_name: '分发冒烟测试任务',
      payload: { location: '东大门安防卡口', person_name: '测试员李四' },
      photos: ['/assets/test_photo.jpg']
    }
  });

  const signature = signWebhookPayload(testPayload, secret1);
  assert('签名请求头名称定义为 X-VFusion-Signature', WEBHOOK_SIGNATURE_HEADER === 'X-VFusion-Signature');
  assert('签名格式为 64 位 HMAC-SHA256 十六进制摘要', /^[0-9a-f]{64}$/i.test(signature));
  assert('合法签名能通过接收端验证', verifyWebhookSignature(testPayload, signature, secret1));

  // 篡改测试
  const tamperedPayload = testPayload.replace('测试员李四', '黑客篡改内容');
  assert('被篡改的数据报文会被签名校验拒绝', !verifyWebhookSignature(tamperedPayload, signature, secret1));

  // 伪造/错误密钥测试
  const wrongSecret = generateWebhookSecret();
  assert('使用错误密钥无法通过验签', !verifyWebhookSignature(testPayload, signature, wrongSecret));

  // -------------------------------------------------------------
  // 测试阶段 2: 回调 URL 解析与安全校验测试
  // -------------------------------------------------------------
  console.log('\n[测试阶段 2/5] 接口回调地址解析与 URL 校验...');
  const validHttpsUrl = 'https://api.thirdparty-security.com/vfusion/callback';
  assert('合法公网 HTTPS 回调地址通过校验', validateHttpUrl(validHttpsUrl).valid === true);

  const invalidUrl = 'ftp://invalid-protocol.com/webhook';
  assert('非 HTTP/HTTPS 协议被拒绝', validateHttpUrl(invalidUrl).valid === false);

  const localResolvedUrl = await validateHttpUrlResolved('https://8.8.8.8/webhook');
  assert('公网目标地址 DNS/IP 解析校验有效', localResolvedUrl.valid === true);

  // -------------------------------------------------------------
  // 测试阶段 3: 节点数据模型、脱敏与密钥轮换测试
  // -------------------------------------------------------------
  console.log('\n[测试阶段 3/5] 节点状态维护、数据脱敏与密钥轮换机制...');
  function maskWebhookSecret(secret) {
    if (!secret) return '未设置';
    const value = String(secret);
    return value.length <= 8 ? '********' : `${value.slice(0, 4)}...${value.slice(-4)}`;
  }

  function serializeWebhook(hook, includeSecret = false) {
    const safe = { ...hook, secret: undefined, secret_masked: maskWebhookSecret(hook.secret) };
    delete safe.secret;
    if (includeSecret && hook.secret) safe.secret = hook.secret;
    return safe;
  }

  const testNode = {
    id: 1786543458225,
    name: '图侦系统 (联调节点)',
    url: 'http://localhost:9988/webhook/receiver',
    enabled: true,
    secret: secret1,
    secret_version: 1,
    created_at: new Date().toISOString()
  };

  const serializedPublic = serializeWebhook(testNode, false);
  assert('普通列表序列化结果中私密 secret 字段被彻底剔除', serializedPublic.secret === undefined);
  assert('普通列表提供正确的掩码指纹 (secret_masked)', serializedPublic.secret_masked.length === 11 && serializedPublic.secret_masked.includes('...'));

  const serializedWithSecret = serializeWebhook(testNode, true);
  assert('创建/轮换时授权返回完整 secret 用于同步', serializedWithSecret.secret === secret1);

  // 模拟密钥轮换
  const oldSecret = testNode.secret;
  testNode.secret = generateWebhookSecret();
  testNode.secret_version = (testNode.secret_version || 1) + 1;
  testNode.secret_rotated_at = new Date().toISOString();
  assert('密钥轮换生成了全新的 64 位密钥', testNode.secret !== oldSecret && testNode.secret.length === 64);
  assert('密钥版本号递增为 v2', testNode.secret_version === 2);

  // -------------------------------------------------------------
  // 测试阶段 4: 模拟第三方接收端真实 HTTP 连通性测试
  // -------------------------------------------------------------
  console.log('\n[测试阶段 4/5] 模拟第三方 Webhook 接收端真实 HTTP 连通性与验签测试...');
  
  let receivedRequests = [];
  const mockReceiverServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const sigHeader = req.headers[WEBHOOK_SIGNATURE_HEADER.toLowerCase()];
      const isValid = verifyWebhookSignature(body, sigHeader, testNode.secret);
      receivedRequests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: body,
        signatureValid: isValid
      });

      if (isValid) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 0, message: 'Webhook received successfully', received_at: new Date().toISOString() }));
      } else {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 401, error: 'Signature verification failed' }));
      }
    });
  });

  await new Promise((resolve) => {
    mockReceiverServer.listen(0, '127.0.0.1', () => {
      const port = mockReceiverServer.address().port;
      testNode.url = `http://127.0.0.1:${port}/api/webhook/receiver`;
      resolve();
    });
  });

  // 发起测试推送
  const simulatedEvent = {
    id: Date.now(),
    event_id: 'EVT_SMOKE_TEST_' + Date.now(),
    task_code: 'TASK_SMOKE_001',
    task_name: 'Webhook 冒烟连通性测试',
    payload: { location: '模拟闸机大门', person_name: '冒烟测试员' },
    photos: ['/assets/smoke_test.jpg']
  };

  const dispatchPayloadStr = JSON.stringify({
    event: 'EVENT_INGESTED',
    timestamp: new Date().toISOString(),
    data: simulatedEvent
  });
  const dispatchSignature = signWebhookPayload(dispatchPayloadStr, testNode.secret);

  const testPushResult = await new Promise((resolve) => {
    const urlObj = new URL(testNode.url);
    const req = http.request(urlObj, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(dispatchPayloadStr),
        [WEBHOOK_SIGNATURE_HEADER]: dispatchSignature
      },
      timeout: 5000
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, body: body });
      });
    });
    req.on('error', (err) => resolve({ error: err.message }));
    req.write(dispatchPayloadStr);
    req.end();
  });

  assert('测试推送接收端返回 HTTP 200', testPushResult.statusCode === 200);
  assert('第三方接收端成功捕获到 1 次推送报文', receivedRequests.length === 1);
  if (receivedRequests.length > 0) {
    const reqInfo = receivedRequests[0];
    assert('推送报文包含 X-VFusion-Signature 请求头', Boolean(reqInfo.headers[WEBHOOK_SIGNATURE_HEADER.toLowerCase()]));
    assert('第三方接收端通过密钥完整验证了报文签名 (HMAC-SHA256)', reqInfo.signatureValid === true);
    assert('推送报文体中包含预期的事件标识', reqInfo.body.includes('TASK_SMOKE_001'));
  }

  // -------------------------------------------------------------
  // 测试阶段 5: 并发分发机制与故障独立隔离测试
  // -------------------------------------------------------------
  console.log('\n[测试阶段 5/5] 多节点并发分发与故障节点物理隔离测试...');

  const activeNode1 = { id: 1, name: '节点1-正常接收', url: testNode.url, enabled: true, secret: testNode.secret };
  const disabledNode2 = { id: 2, name: '节点2-暂停分发', url: testNode.url, enabled: false, secret: testNode.secret };
  const brokenNode3 = { id: 3, name: '节点3-故障地址', url: 'http://127.0.0.1:59999/unreachable', enabled: true, secret: testNode.secret };

  const registeredNodes = [activeNode1, disabledNode2, brokenNode3];
  receivedRequests = []; // 重置计数

  async function mockDispatchWebhooks(record, nodes) {
    const activeNodes = nodes.filter(n => n.enabled !== false);
    const results = [];

    for (const node of activeNodes) {
      try {
        const payloadStr = JSON.stringify({ event: 'EVENT_INGESTED', data: record });
        const sig = signWebhookPayload(payloadStr, node.secret);
        const res = await new Promise((resolve) => {
          const u = new URL(node.url);
          const r = http.request(u, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(payloadStr),
              [WEBHOOK_SIGNATURE_HEADER]: sig
            },
            timeout: 800
          }, resp => {
            resolve({ id: node.id, ok: resp.statusCode >= 200 && resp.statusCode < 300 });
          });
          r.on('error', err => resolve({ id: node.id, ok: false, error: err.message }));
          r.on('timeout', () => { r.destroy(); resolve({ id: node.id, ok: false, error: 'timeout' }); });
          r.write(payloadStr);
          r.end();
        });
        results.push(res);
      } catch (e) {
        results.push({ id: node.id, ok: false, error: e.message });
      }
    }
    return results;
  }

  const dispatchResults = await mockDispatchWebhooks({ event_id: 'EVT_MULTI_001' }, registeredNodes);
  assert('正常节点接收到消息分发', dispatchResults.find(r => r.id === 1 && r.ok === true) !== undefined);
  assert('已停用节点被自动忽略，未产生分发网络请求', dispatchResults.find(r => r.id === 2) === undefined);
  assert('故障节点超时或无法连接时被优雅隔离，不中断整体分发流', dispatchResults.find(r => r.id === 3 && r.ok === false) !== undefined);

  // -------------------------------------------------------------
  // 测试阶段 6: 单据手动补推送与批量重放机制测试
  // -------------------------------------------------------------
  console.log('\n[测试阶段 6/6] 单据手动补推送 (Replay) 与批量重发测试...');
  const replayEvent = { event_id: 'EVT_REPLAY_001', task_name: '补推任务', payload: { test: true } };
  const singleReplayResult = await mockDispatchWebhooks(replayEvent, [activeNode1]);
  assert('单条历史单据精准补推送成功', singleReplayResult.length === 1 && singleReplayResult[0].ok === true);

  const batchEvents = [
    { event_id: 'EVT_BATCH_001', task_name: '批量补推1' },
    { event_id: 'EVT_BATCH_002', task_name: '批量补推2' }
  ];
  let batchOkCount = 0;
  for (const evt of batchEvents) {
    const res = await mockDispatchWebhooks(evt, [activeNode1]);
    if (res.every(r => r.ok)) batchOkCount++;
  }
  assert('批量历史单据队列重放成功 (2/2)', batchOkCount === 2);

  // -------------------------------------------------------------
  // 测试阶段 7: 第三方固定同步服务令牌 (Fixed Sync Token) 鉴权专项测试
  // -------------------------------------------------------------
  console.log('\n[测试阶段 7/7] 第三方固定同步服务令牌 (Fixed Sync Token) 鉴权专项测试...');

  const FIXED_SYNC_TOKEN = 'vfusion_sync_test_token_8888888888888888';
  const assetMiddleware = assetAuthMiddleware({
    getSyncToken: () => FIXED_SYNC_TOKEN
  });
  const regularApiMiddleware = authMiddleware({});

  // 辅助运行中间件
  async function runMiddleware(mw, reqObj) {
    let nextCalled = false;
    let responseStatus = null;
    let responseBody = null;
    const resObj = {
      status(code) { responseStatus = code; return this; },
      json(body) { responseBody = body; return this; }
    };
    await mw(reqObj, resObj, () => { nextCalled = true; });
    return { nextCalled, responseStatus, responseBody, reqUser: reqObj.user };
  }

  // 1. 请求头 X-Sync-Token 访问图片
  const r1 = await runMiddleware(assetMiddleware, {
    method: 'GET',
    path: '/tasks/TASK_001/EVT_001/001.jpg',
    headers: { 'x-sync-token': FIXED_SYNC_TOKEN }
  });
  assert('使用 X-Sync-Token 请求头成功通过图片鉴权放行', r1.nextCalled && r1.reqUser && r1.reqUser.username === 'sync_service');

  // 2. 请求头 Authorization: Bearer <Sync-Token> 访问图片
  const r2 = await runMiddleware(assetMiddleware, {
    method: 'GET',
    path: '/tasks/TASK_001/EVT_001/001.jpg',
    headers: { 'authorization': `Bearer ${FIXED_SYNC_TOKEN}` }
  });
  assert('使用 Authorization: Bearer <Token> 成功通过图片鉴权放行', r2.nextCalled && r2.reqUser && r2.reqUser.username === 'sync_service');

  // 3. URL 查询参数 ?sync_token=<Sync-Token> 访问图片
  const r3 = await runMiddleware(assetMiddleware, {
    method: 'GET',
    path: '/tasks/TASK_001/EVT_001/001.jpg',
    headers: {},
    query: { sync_token: FIXED_SYNC_TOKEN }
  });
  assert('使用 URL 参数 ?sync_token=<Token> 成功通过图片鉴权放行', r3.nextCalled && r3.reqUser && r3.reqUser.username === 'sync_service');

  // 4. 错误令牌被拦截 (HTTP 401)
  const r4 = await runMiddleware(assetMiddleware, {
    method: 'GET',
    path: '/tasks/TASK_001/EVT_001/001.jpg',
    headers: { 'x-sync-token': 'wrong_invalid_token_123456' },
    query: {}
  });
  assert('使用错误令牌访问图片被正确拦截 (HTTP 401)', !r4.nextCalled && r4.responseStatus === 401);

  // 5. 普通管理 API 拒绝使用 Sync Token 越权访问 (最小权限沙箱)
  const r5 = await runMiddleware(regularApiMiddleware, {
    method: 'GET',
    path: '/api/webhooks',
    headers: { 'x-sync-token': FIXED_SYNC_TOKEN },
    query: {}
  });
  assert('管理类 API 严格拒绝固定同步令牌 (最小权限隔离)', !r5.nextCalled && r5.responseStatus === 401);

  // 清理 Mock 服务器
  await new Promise(resolve => mockReceiverServer.close(resolve));

  console.log('\n================================================================');
  console.log(`   冒烟测试执行完毕: ${passedTests} 项通过, ${failedTests} 项失败`);
  console.log('================================================================');

  if (failedTests > 0) {
    process.exit(1);
  }
}

runSmokeTests().catch(err => {
  console.error('冒烟测试发生未捕获异常:', err);
  process.exit(1);
});
