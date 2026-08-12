const fs = require('fs');
const path = require('path');
const http = require('http');

const STORAGE_ROOT = path.resolve(__dirname, '../storage');
const testPhoto = path.join(STORAGE_ROOT, 'test_live_snap.jpg');
fs.writeFileSync(testPhoto, Buffer.from('TEST_JPEG_SNAPSHOT_BINARY_DATA_2026'));

const boundary = '----WebKitFormBoundary' + Math.random().toString(16).substring(2);

const eventId = 'EVT_LIVE_' + Date.now();
const fields = {
  app_id: 'sys_gate_security',
  biz_type: 'GATE_ACCESS',
  event_id: eventId,
  task_code: 'TASK_BORDER_PATROL',
  task_name: '厂区周界安防例行巡检',
  operator: '系统联调员 (admin)',
  operator_username: 'admin',
  operator_name: '系统联调员',
  submit_time: new Date().toISOString(),
  location: '联调测试大门1号',
  person_name: '王五',
  person_id_card: '110101199505051234',
  person_domicile: '北京市海淀区',
  event_description: '视频网至内网端到端连通性测试消息'
};

let bodyParts = [];
for (const [key, value] of Object.entries(fields)) {
  bodyParts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`);
}

const fileHeader = `--${boundary}\r\nContent-Disposition: form-data; name="images"; filename="test_live_snap.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`;
const fileFooter = `\r\n--${boundary}--\r\n`;

const fileBuffer = fs.readFileSync(testPhoto);
const bodyBuffer = Buffer.concat([
  Buffer.from(bodyParts.join('')),
  Buffer.from(fileHeader),
  fileBuffer,
  Buffer.from(fileFooter)
]);

async function runTest() {
  console.log('1. 登录视频网端 (5001)...');
  const token = await new Promise((resolve) => {
    const loginData = JSON.stringify({ username: 'admin', password: 'admin123' });
    const loginReq = http.request('http://localhost:5001/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(loginData) }
    }, (res) => {
      let b = '';
      res.on('data', chunk => b += chunk);
      res.on('end', () => {
        try {
          const j = JSON.parse(b);
          resolve((j.data && j.data.token) || j.token || '');
        } catch (e) { resolve(''); }
      });
    });
    loginReq.write(loginData);
    loginReq.end();
  });

  console.log('   获取 Token 成功:', token ? token.slice(0, 20) + '...' : '无');
  console.log('\n2. 向视频网端 (5001) 提交现场抓拍单据包...');

  const req = http.request('http://localhost:5001/api/publish', {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': bodyBuffer.length,
      'Authorization': `Bearer ${token}`
    }
  }, (res) => {
  let body = '';
  res.on('data', chunk => body += chunk);
  res.on('end', () => {
    console.log('   视频网响应 HTTP Status:', res.statusCode);
    console.log('   响应内容:', body);

    console.log('\n2. 等待 4 秒供 Core (5002) 自动摆渡、解包、验签与 Webhook 分发...');
    setTimeout(async () => {
      http.get('http://localhost:5002/api/events', (coreRes) => {
        let coreBody = '';
        coreRes.on('data', chunk => coreBody += chunk);
        coreRes.on('end', () => {
          try {
            const json = JSON.parse(coreBody);
            const found = (json.data || []).find(e => e.event_id === eventId);
            if (found) {
              console.log('   ✓ 成功在内网中台 (5002) 查询到已自动摆渡入库的事件！');
              console.log('     事件 ID:', found.event_id);
              console.log('     涉事人员:', found.payload ? found.payload.person_name : '未填');
              console.log('     照片路径:', found.files ? found.files.map(f => f.url).join(', ') : '无');
            } else {
              console.log('   ✕ 未在内网中台查询到事件');
            }
          } catch (e) {
            console.error('   解析响应异常:', e.message);
          }
          if (fs.existsSync(testPhoto)) fs.unlinkSync(testPhoto);
        });
      });
    }, 4000);
  });
});

req.on('error', err => console.error('请求失败:', err.message));
req.write(bodyBuffer);
req.end();
}

runTest().catch(console.error);
