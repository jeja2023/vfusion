require('../packages/common/env_loader').initEnv();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const SQLiteStorageEngine = require('../packages/common/db_sqlite');
const { packEventPackage } = require('../packages/common/packager');
const { unpackAndVerifyPackage } = require('../packages/common/unpacker');
const { setHmacSecret } = require('../packages/common/protocol');

async function runSmokeTest() {
  console.log('===========================================================');
  console.log(' 视汇 (VFusion) 跨网端到端自动化冒烟测试 (测试数据保留模式)');
  console.log('===========================================================');

  const STORAGE_ROOT = path.resolve(__dirname, '../storage');
  const SECURITY_CONFIG_FILE = path.join(STORAGE_ROOT, 'security.json');
  const FTP_OUT_DIR = path.join(STORAGE_ROOT, 'ftp_out');
  const ARCHIVE_DIR = path.join(STORAGE_ROOT, 'archive');
  const ASSETS_DIR = path.join(STORAGE_ROOT, 'assets');
  const COLLECTOR_ASSETS_DIR = path.join(STORAGE_ROOT, 'collector_assets');

  [STORAGE_ROOT, FTP_OUT_DIR, ARCHIVE_DIR, ASSETS_DIR, COLLECTOR_ASSETS_DIR].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  });

  // 加载共享 HMAC 密钥
  const { getHmacSecret } = require('../packages/common/protocol');
  let hmacSecret = getHmacSecret();
  if (fs.existsSync(SECURITY_CONFIG_FILE)) {
    try {
      const sec = JSON.parse(fs.readFileSync(SECURITY_CONFIG_FILE, 'utf8'));
      if (sec.hmac_secret) hmacSecret = sec.hmac_secret;
    } catch (e) {}
  }
  setHmacSecret(hmacSecret);
  console.log('\n[1/5] 加载加密签名秘钥: OK (HMAC 秘钥就绪)');

  // 初始化双端 SQLite 数据库引擎
  const collectorSqlite = new SQLiteStorageEngine(path.join(STORAGE_ROOT, 'vfusion_collector.db'));
  const coreSqlite = new SQLiteStorageEngine(path.join(STORAGE_ROOT, 'vfusion_core.db'));

  // Step 1: 在视频网端创建冒烟测试任务
  console.log('\n[2/5] 视频网端 (Collector): 创建冒烟测试任务与照片生成...');
  const taskCode = 'TASK_20260812_SMOKE01';
  const taskName = '厂区北门周界安防冒烟巡检任务';
  const taskDesc = '自动化冒烟测试 - 验证跨网照片采集打包、防篡改签名与内网接收归集';
  const operatorUsername = 'admin';
  const operatorName = '视频网管理员';
  const operator = `${operatorName} (${operatorUsername})`;
  const submitTime = new Date().toISOString();

  await collectorSqlite.saveTask({
    task_code: taskCode,
    task_name: taskName,
    description: taskDesc,
    creator_username: operatorUsername,
    creator_name: operatorName,
    share_code: taskCode,
    is_shared: true,
    status: 'ACTIVE',
    created_at: submitTime,
    updated_at: submitTime
  });
  console.log(` -> 视频网端任务创建成功: [${taskName}] (${taskCode})`);

  // 创建真实抓拍样例照片文件
  const samplePhotoPath = path.join(STORAGE_ROOT, 'smoke_sample_photo.jpg');
  const fakePhotoData = Buffer.from(
    'FFD8FFE000104A46494600010101006000600000FFFE001756467573696F6E536D6F6B655465737450686F746F' +
    '46464646464646464646464646464646464646464646464646464646464646464646464646464646464646FFD9',
    'hex'
  );
  fs.writeFileSync(samplePhotoPath, fakePhotoData);

  // 复制一份至视频网静态资源目录
  const eventId = `EVT_SMOKE_${Date.now()}`;
  const collectorEventAssetDir = path.join(COLLECTOR_ASSETS_DIR, eventId);
  if (!fs.existsSync(collectorEventAssetDir)) fs.mkdirSync(collectorEventAssetDir, { recursive: true });
  const collectorPhotoDest = path.join(collectorEventAssetDir, '001.jpg');
  fs.copyFileSync(samplePhotoPath, collectorPhotoDest);

  const savedFileRecords = [{
    id: `img_${eventId}_0_smoke`,
    filename: '001.jpg',
    url: `/collector-assets/${eventId}/001.jpg`,
    timestamp: submitTime,
    uploader_username: operatorUsername,
    uploader_name: operatorName,
    description: '厂区北门红外对射防区例行抓拍存照（冒烟测试）',
    location: '厂区北门主干道防区1'
  }];

  const payload = {
    location: '厂区北门主干道防区1',
    transportation: '小型客车',
    person_name: '张三',
    person_id_card: '110101199003072378',
    person_domicile: '北京市东城区',
    description: '厂区北门红外对射防区例行抓拍存照（冒烟测试）'
  };

  // Step 2: 视频网端数据打包与 HMAC-SHA256 数字签名
  console.log('\n[3/5] 视频网端 (Collector): 生成单据包与 HMAC-SHA256 数字签名...');
  const packResult = await packEventPackage({
    outputDir: FTP_OUT_DIR,
    appId: 'sys_gate_security',
    bizType: 'person_snapshot',
    eventId,
    taskName,
    taskCode,
    operator,
    operatorUsername,
    operatorName,
    submitTime,
    payload,
    files: [{ path: samplePhotoPath, filename: '001.jpg' }]
  });

  console.log(` -> 数据摆渡包打包成功: ${packResult.pkgName}.zip`);
  console.log(` -> HMAC-SHA256 签名 (64位): ${packResult.info.signature}`);

  // 保存至视频网端数据库
  await collectorSqlite.saveEvent({
    id: Date.now(),
    app_id: 'sys_gate_security',
    biz_type: 'person_snapshot',
    event_id: eventId,
    task_name: taskName,
    task_code: taskCode,
    timestamp: submitTime,
    operator,
    operator_username: operatorUsername,
    operator_name: operatorName,
    payload,
    files: savedFileRecords,
    zip_hash: packResult.pkgName,
    signature: packResult.info.signature,
    status: 'PACKED'
  });
  console.log(' -> 已存入视频网端本地历史数据库 (vfusion_collector.db)');

  // Step 3: 网闸单向摆渡与内网端安全验签解包
  console.log('\n[4/5] 网闸摆渡与内网中台 (Core): 安全验签、解包与照片归集...');
  const archiveZipPath = path.join(ARCHIVE_DIR, path.basename(packResult.zipPath));
  fs.copyFileSync(packResult.zipPath, archiveZipPath); // 模拟网闸单向传输

  const unpackResult = await unpackAndVerifyPackage(archiveZipPath, ASSETS_DIR);
  console.log(' -> 内网验签解包成功: HMAC 数字签名与 SHA-256 校验和 100% 匹配!');

  // 将解压照片移动到内网端静态资源库
  const coreEventAssetDir = path.join(ASSETS_DIR, eventId);
  if (!fs.existsSync(coreEventAssetDir)) fs.mkdirSync(coreEventAssetDir, { recursive: true });
  
  const coreSavedFiles = (unpackResult.info.files || []).map((f, idx) => {
    const fn = f.filename || `image_${idx}.jpg`;
    return {
      id: `img_core_${eventId}_${idx}`,
      filename: fn,
      url: `/assets/${eventId}/${fn}`,
      timestamp: f.timestamp || submitTime,
      uploader_username: operatorUsername,
      uploader_name: operatorName,
      description: payload.description || '',
      location: payload.location || ''
    };
  });

  // Step 4: 保存至内网端数据库 (保留测试数据)
  await coreSqlite.saveTask({
    task_code: taskCode,
    task_name: taskName,
    description: taskDesc,
    creator_username: operatorUsername,
    creator_name: operatorName,
    share_code: taskCode,
    is_shared: true,
    status: 'ACTIVE',
    created_at: submitTime,
    updated_at: submitTime
  });

  await coreSqlite.saveEvent({
    id: Date.now(),
    app_id: 'sys_gate_security',
    biz_type: 'person_snapshot',
    event_id: eventId,
    task_name: taskName,
    task_code: taskCode,
    timestamp: submitTime,
    operator,
    operator_username: operatorUsername,
    operator_name: operatorName,
    payload,
    files: coreSavedFiles,
    zip_hash: packResult.pkgName,
    signature: packResult.info.signature,
    status: 'INGESTED'
  });
  console.log(' -> 已成功归集并持久化至内网中台数据库 (vfusion_core.db)');

  // Step 5: 验证数据留存与查询连通性
  console.log('\n[5/5] 验证测试数据留存与查询连通性...');
  const collectorTasks = await collectorSqlite.getTasks();
  const collectorImages = await collectorSqlite.getTaskImages(taskCode);
  const coreTasks = await coreSqlite.getTasks();
  const coreImages = await coreSqlite.getTaskImages(taskCode);

  console.log(` -> 视频网端查询: 包含任务 ${collectorTasks.length} 个, 关联照片 ${collectorImages.length} 张`);
  console.log(` -> 内网中台查询: 包含任务 ${coreTasks.length} 个, 关联照片 ${coreImages.length} 张`);

  console.log('\n===========================================================');
  console.log(' 冒烟测试成功完成！测试数据已全部完好保留在数据库中。');
  console.log(` • 冒烟测试任务: [${taskName}] (${taskCode})`);
  console.log(` • 单据 ID: ${eventId}`);
  console.log(` • 涉事人员: 张三 (110101199003072378)`);
  console.log(` • 照片预览路径: /collector-assets/${eventId}/001.jpg`);
  console.log(' 您可在浏览器前端随时刷新查看与验证。');
  console.log('===========================================================');
}

runSmokeTest().catch(err => {
  console.error('\n❌ 冒烟测试异常:', err);
  process.exit(1);
});
