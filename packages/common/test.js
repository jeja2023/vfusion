const path = require('path');
const fs = require('fs');
const { packEventPackage } = require('./packager');
const { unpackAndVerifyPackage } = require('./unpacker');

async function runTest() {
  console.log('=== VFusion 单元测试: 打包与解包校验 ===');

  const testDir = path.join(__dirname, 'test_tmp');
  const outDir = path.join(testDir, 'out');
  const extractTargetDir = path.join(testDir, 'extract');

  if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  fs.mkdirSync(testDir, { recursive: true });

  // 1. 创建测试伪图片
  const sampleImgPath = path.join(testDir, 'test_sample.jpg');
  fs.writeFileSync(sampleImgPath, 'FAKE_IMAGE_BINARY_DATA_FOR_VFUSION_TEST_' + Date.now());

  // 2. 打包测试
  console.log('[1/3] 测试打包...');
  const packResult = await packEventPackage({
    outputDir: outDir,
    appId: 'sys_test',
    bizType: 'test_snapshot',
    eventId: 'EVT_TEST_1001',
    operator: 'Tester',
    payload: { location: '测试车间', threat_level: '高' },
    files: [{ path: sampleImgPath, filename: '001.jpg' }]
  });

  console.log(` -> 成功生成打包文件: ${packResult.zipPath}`);

  // 3. 解包与校验测试
  console.log('[2/3] 测试解包与 MD5 校验和...');
  const unpackResult = await unpackAndVerifyPackage(packResult.zipPath, extractTargetDir);
  console.log(' -> 解包成功，读取 info.json:', unpackResult.info.event_id);

  // 4. 清理测试目录
  console.log('[3/3] 清理临时测试文件...');
  fs.rmSync(testDir, { recursive: true, force: true });

  console.log('=== ✅ VFusion 单元测试成功通过！ ===');
}

runTest().catch(err => {
  console.error('❌ 测试失败:', err);
  process.exit(1);
});
