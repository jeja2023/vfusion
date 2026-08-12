const crypto = require('crypto');
const http = require('http');

const secret = process.argv[2] || 'fd7d46f0146c9e929800453e6705e856162479c32413b978eafa0fc7febd5904';
const testEvent = {
  id: Date.now(),
  event_id: 'EVT_TEST_' + Date.now(),
  task_code: 'TASK_TEST_001',
  task_name: 'Webhook 联调测试任务',
  schema_id: 'sys_gate_security',
  timestamp: new Date().toISOString(),
  submit_time: new Date().toISOString(),
  operator: '系统联调员 (admin)',
  operator_username: 'admin',
  operator_name: '系统联调员',
  payload: {
    location: '模拟测试大门',
    person_name: '测试人员',
    person_id_card: '110101199001011234',
    description: '视汇中台 Webhook 联调连通性测试消息'
  },
  files: [{ filename: 'test_photo.jpg', url: 'http://172.26.64.1:5002/assets/test_photo.jpg' }],
  photos: ['http://172.26.64.1:5002/assets/test_photo.jpg'],
  created_at: new Date().toISOString()
};

const payload = JSON.stringify({
  event: 'EVENT_INGESTED',
  timestamp: new Date().toISOString(),
  data: testEvent
});
const signature = crypto.createHmac('sha256', secret).update(payload).digest('hex');

console.log('Testing with Secret:', secret);
console.log('Calculated Signature:', signature);

const req = http.request('http://localhost:44375/Shared/Handlers/VFusion/VFusionPhotoWebhook.ashx', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'X-VFusion-Signature': signature
  },
  timeout: 5000
}, (res) => {
  let body = '';
  res.on('data', chunk => body += chunk);
  res.on('end', () => {
    console.log('HTTP Status:', res.statusCode);
    console.log('Headers:', JSON.stringify(res.headers, null, 2));
    console.log('Body:', body.substring(0, 500));
  });
});

req.on('error', (err) => {
  console.log('Connection Error:', err.message);
});

req.on('timeout', () => {
  console.log('Timeout!');
  req.destroy();
});

req.write(payload);
req.end();
