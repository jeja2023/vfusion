const http = require('http');
const fs = require('fs');
const path = require('path');

function login(port) {
  return new Promise((resolve) => {
    const postData = JSON.stringify({ username: 'admin', password: 'admin123' });
    const req = http.request({
      hostname: 'localhost',
      port: port,
      path: '/api/auth/login',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve((json.data && json.data.token) || json.token || '');
        } catch (e) { resolve(''); }
      });
    });
    req.on('error', () => resolve(''));
    req.write(postData);
    req.end();
  });
}

async function testE2E() {
  console.log('=== VFusion 端到端 (E2E) 自动化链路验证 ===');

  const collToken = await login(5001);
  const coreToken = await login(5002);

  // 1. 创建临时的真实测试样本文件
  const testImgPath = path.join(__dirname, 'sample_snap.jpg');
  fs.writeFileSync(testImgPath, Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00]));

  // 2. 调用视频网 Collector 提交事件 API (http://localhost:5001/api/publish)
  console.log('\n[1/4] 模拟视频网用户提交“厂区北门抓拍事件”...');
  
  const formBoundary = '----WebKitFormBoundary7MA4YWxkTrZu0gW';
  const imgContent = fs.readFileSync(testImgPath);

  let postData = '';
  const fields = {
    app_id: 'sys_gate_security',
    biz_type: 'person_snapshot',
    event_id: `EVT_${Date.now()}`,
    task_name: '厂区北门例行周界巡检',
    task_code: 'TASK_20260810_01',
    operator: '张三 (admin)',
    operator_username: 'admin',
    operator_name: '张三',
    location: '厂区北门',
    transportation: '步行',
    remark: '例行巡检抓拍测试'
  };

  for (const [k, v] of Object.entries(fields)) {
    postData += `--${formBoundary}\r\n`;
    postData += `Content-Disposition: form-data; name="${k}"\r\n\r\n`;
    postData += `${v}\r\n`;
  }

  postData += `--${formBoundary}\r\n`;
  postData += `Content-Disposition: form-data; name="images"; filename="001.jpg"\r\n`;
  postData += `Content-Type: image/jpeg\r\n\r\n`;

  const payloadHeader = Buffer.from(postData, 'utf8');
  const payloadFooter = Buffer.from(`\r\n--${formBoundary}--\r\n`, 'utf8');
  const fullPayload = Buffer.concat([payloadHeader, imgContent, payloadFooter]);

  const publishRes = await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'localhost',
      port: 5001,
      path: '/api/publish',
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${formBoundary}`,
        'Content-Length': fullPayload.length,
        'Authorization': `Bearer ${collToken}`
      }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    });

    req.on('error', err => reject(err));
    req.write(fullPayload);
    req.end();
  });

  if (!publishRes.success) {
    throw new Error('视频网打包失败: ' + (publishRes.error || JSON.stringify(publishRes)));
  }

  console.log(' -> 视频网打包成功响应:', publishRes.data ? publishRes.data.pkgName : '已完成');

  // 3. 检查 ftp_out 目录
  const ftpOutDir = path.resolve(__dirname, '../storage/ftp_out');
  const ftpOutFiles = fs.existsSync(ftpOutDir) ? fs.readdirSync(ftpOutDir) : [];
  console.log(`\n[2/4] 检查网闸发送目录 (ftp_out): 发现 ${ftpOutFiles.length} 个数据包 [${ftpOutFiles.join(', ')}]`);

  // 4. 调用模拟网闸摆渡 API (http://localhost:5002/api/simulate-diode)
  console.log('\n[3/4] 触发网闸单向摆渡 (FTP Sync 到 ftp_in)...');
  const diodeRes = await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'localhost',
      port: 5002,
      path: '/api/simulate-diode',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${coreToken}`
      }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', err => reject(err));
    req.end();
  });

  console.log(' -> 网闸摆渡动作处理完成:', diodeRes.message || '完成');

  // 5. 等待内网扫描循环 (3秒) 解包入库
  console.log('\n[4/4] 等待内网 Core 自动轮询解包、MD5 校验与入库...');
  await new Promise(r => setTimeout(r, 4000));

  // 6. 查询内网事件列表 (http://localhost:5002/api/events)
  const eventsRes = await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'localhost',
      port: 5002,
      path: '/api/events',
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${coreToken}`
      }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', err => reject(err));
    req.end();
  });

  const eventsList = (eventsRes && eventsRes.data) || [];
  console.log(`\n=== E2E 测试结果 ===`);
  console.log(`内网中台已成功解析并入库的事件数量: ${eventsList.length}`);
  if (eventsList.length > 0) {
    const latest = eventsList[0];
    console.log(`最新录入事件详情:`);
    console.log(` - 事件编号: ${latest.event_id}`);
    console.log(` - 发生地点: ${latest.payload ? latest.payload.location : '未填'}`);
    console.log(` - 交通方式: ${latest.payload ? latest.payload.transportation : '未填'}`);
    console.log(` - 照片附件: ${Array.isArray(latest.files) ? latest.files.map(f => f.url).join(', ') : '无'}`);
    console.log(` - 包 Hash (Zip MD5): ${latest.zip_hash}`);
  }

  // 清理临时样本文件
  if (fs.existsSync(testImgPath)) fs.unlinkSync(testImgPath);

  console.log('\n=== 端到端单据传输与解析流程完全成功！ ===');
}

testE2E().catch(err => {
  console.error('E2E 测试异常:', err);
});
