const path = require('path');
const fs = require('fs');
const SQLiteStorageEngine = require('./db_sqlite');

let passed = 0;
let failed = 0;

function check(name, condition) {
  if (condition) {
    console.log(`  [PASS] ${name}`);
    passed++;
  } else {
    console.error(`  [FAIL] ${name}`);
    failed++;
  }
}

async function runTaskImagesTest() {
  console.log('=== VFusion 单元测试: 任务、按时间顺序图片及权限控制底层 CRUD ===');

  const testDbPath = path.join(__dirname, 'test_tmp_db', 'test_vfusion.db');
  const dir = path.dirname(testDbPath);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });

  const storage = new SQLiteStorageEngine(testDbPath);

  // 1. 创建任务与查询
  console.log('\n[1/5] 任务创建与更新测试');
  const t1 = await storage.saveTask({
    task_code: 'TASK_TEST_001',
    task_name: '厂区智能安防巡检',
    description: '巡检测试任务描述',
    creator_username: 'user_alice',
    creator_name: 'Alice',
    is_shared: true,
    status: 'ACTIVE'
  });
  check('任务创建成功', t1 && t1.task_code === 'TASK_TEST_001');
  const taskStats = await storage.getTaskStats();
  check('任务统计支持数据库聚合', taskStats && typeof taskStats === 'object');

  const updatedTask = await storage.updateTaskDetails('TASK_TEST_001', {
    task_name: '厂区智能安防巡检(已修改)',
    description: '修改后的描述'
  });
  check('任务更新成功', updatedTask && updatedTask.task_name === '厂区智能安防巡检(已修改)');

  // 2. 写入包含不同时间戳的图片事件
  console.log('\n[2/5] 写入时间序列图片单据');
  const now = Date.now();
  const timeA = new Date(now - 10000).toISOString();
  const timeB = new Date(now - 5000).toISOString();
  const timeC = new Date(now).toISOString();

  storage.saveEvent({
    event_id: 'EVT_001',
    task_code: 'TASK_TEST_001',
    task_name: '厂区智能安防巡检(已修改)',
    timestamp: timeB,
    operator: 'Alice (user_alice)',
    operator_username: 'user_alice',
    operator_name: 'Alice',
    files: [
      {
        id: 'img_evt001_1',
        filename: 'photo_mid.jpg',
        url: '/assets/photo_mid.jpg',
        timestamp: timeB,
        uploader_username: 'user_alice',
        uploader_name: 'Alice',
        description: '中间拍摄的照片'
      }
    ]
  });

  storage.saveEvent({
    event_id: 'EVT_002',
    task_code: 'TASK_TEST_001',
    task_name: '厂区智能安防巡检(已修改)',
    timestamp: timeA,
    operator: 'Bob (user_bob)',
    operator_username: 'user_bob',
    operator_name: 'Bob',
    files: [
      {
        id: 'img_evt002_1',
        filename: 'photo_earliest.jpg',
        url: '/assets/photo_earliest.jpg',
        timestamp: timeA,
        uploader_username: 'user_bob',
        uploader_name: 'Bob',
        description: '最早拍摄的照片'
      }
    ]
  });

  storage.saveEvent({
    event_id: 'EVT_003',
    task_code: 'TASK_TEST_001',
    task_name: '厂区智能安防巡检(已修改)',
    timestamp: timeC,
    operator: 'user_alice',
    files: [
      {
        id: 'img_evt003_1',
        filename: 'photo_latest.jpg',
        url: '/assets/photo_latest.jpg',
        timestamp: timeC,
        uploader_username: 'user_alice',
        uploader_name: 'Alice',
        description: '最新拍摄的照片'
      }
    ]
  });

  // 3. 验证图片是否严格按时间顺序 (Chronological Order) 排列
  console.log('\n[3/5] 图片时间顺序 (Chronological Order) 验证');
  const ascImages = await storage.getTaskImages('TASK_TEST_001', 'ASC');
  check('提取到3张图片', ascImages.length === 3);
  check('正序排列第1张为最早照片', ascImages[0].id === 'img_evt002_1');
  check('正序排列第2张为中间照片', ascImages[1].id === 'img_evt001_1');
  check('正序排列第3张为最新照片', ascImages[2].id === 'img_evt003_1');

  const descImages = await storage.getTaskImages('TASK_TEST_001', 'DESC');
  check('倒序排列第1张为最新照片', descImages[0].id === 'img_evt003_1');

  // 4. 修改与删除图片测试
  console.log('\n[4/5] 修改与删除图片元数据测试');
  const editedImg = await storage.updateImageMetadata('img_evt001_1', {
    description: '修改后的图片备注信息',
    location: '1号车间东门'
  });
  check('图片信息更新成功', editedImg && editedImg.description === '修改后的图片备注信息' && editedImg.location === '1号车间东门');

  const deleteSuccess = await storage.deleteImage('img_evt002_1');
  check('图片删除成功', deleteSuccess);

  const afterDeleteImages = await storage.getTaskImages('TASK_TEST_001', 'ASC');
  check('删除后剩余2张图片', afterDeleteImages.length === 2);
  check('被删除图片不在列表中', !afterDeleteImages.some(i => i.id === 'img_evt002_1'));

  // 5. 删除任务测试
  console.log('\n[5/5] 删除任务测试');
  await storage.deleteTask('TASK_TEST_001');
  const deletedTaskQuery = await storage.getTaskByCode('TASK_TEST_001');
  check('任务已成功删除', deletedTaskQuery === null);
  check('删除任务同时删除事件', (await storage.getEventByEventId('EVT_001')) === null);

  // 清理测试目录
  try {
    if (storage.db) storage.db.close();
    setTimeout(() => {
      try { if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
    }, 100);
  } catch (e) {}

  console.log(`\n=== 测试结果: ${passed} 通过, ${failed} 失败 ===`);
  if (failed > 0) process.exit(1);
  console.log('=== VFusion 任务及图片底层逻辑单元测试全部通过！ ===');
}

runTaskImagesTest().catch(err => {
  console.error('测试异常:', err);
  process.exit(1);
});
