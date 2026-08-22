const fs = require('fs');
const path = require('path');
const http = require('http');

async function runDoctor() {
  console.log('===================================================');
  console.log(' 视汇 (VFusion) 系统健康度与部署诊断工具 (v0.19.0)');
  console.log('===================================================');

  let issueCount = 0;
  const storageRoot = path.resolve(__dirname, '../../storage');

  // 1. 检查存储目录
  console.log('\n[1/4] 检查文件存储与隔离网目录拓扑...');
  const dirs = ['ftp_out', 'ftp_in', 'archive', 'error', 'assets'];
  for (const d of dirs) {
    const p = path.join(storageRoot, d);
    if (!fs.existsSync(p)) {
      fs.mkdirSync(p, { recursive: true });
      console.log(` -> 目录已补全: ${d}`);
    } else {
      console.log(` -> 目录正常: ${d}`);
    }
  }

  // 2. 检查节点连通性
  console.log('\n[2/4] 检查服务节点连通性...');
  const checkPort = (port, name) => {
    return new Promise(resolve => {
      http.get(`http://localhost:${port}/api/schema`, res => {
        console.log(` -> ${name} (端口 ${port}): 运行正常 [HTTP ${res.statusCode}]`);
        resolve(true);
      }).on('error', () => {
        console.log(` -> ${name} (端口 ${port}): 服务未启动`);
        issueCount++;
        resolve(false);
      });
    });
  };

  await checkPort(5001, '视频网发布终端 (Collector)');
  await checkPort(5002, '内网汇聚中台 (Core)');

  // 3. 检查系统配置文件
  console.log('\n[3/4] 检查系统配置文件规范...');
  const schemaFile = path.join(storageRoot, 'schema.json');
  const dbFile = path.join(storageRoot, 'db.json');

  if (fs.existsSync(schemaFile)) {
    try {
      const schema = JSON.parse(fs.readFileSync(schemaFile, 'utf8'));
      console.log(` -> 表单 Schema 规范正常 (包含 ${schema.fields.length} 个动态字段)`);
    } catch (e) {
      console.log(` -> 表单 Schema 格式异常!`);
      issueCount++;
    }
  }

  if (fs.existsSync(dbFile)) {
    try {
      const db = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
      console.log(` -> 数据库正常 (累积存储 ${db.events.length} 条单据记录)`);
    } catch (e) {
      console.log(` -> 数据库文件损坏!`);
      issueCount++;
    }
  }

  // 4. 诊断结果汇总
  console.log('\n===================================================');
  if (issueCount === 0) {
    console.log(' 诊断完成: VFusion 系统环境完全健康，无异常！');
  } else {
    console.log(` 诊断完成: 发现 ${issueCount} 处提示，建议启动相关服务。`);
  }
  console.log('===================================================\n');
}

runDoctor();
