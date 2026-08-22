const path = require('path');
const fs = require('fs');
const archiver = require('archiver');
const { packEventPackage } = require('./packager');
const { unpackAndVerifyPackage } = require('./unpacker');
const { md5String } = require('./checksum');

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

async function expectReject(name, fn) {
  try {
    await fn();
    console.error(`  [FAIL] ${name} (预期抛错但却通过了)`);
    failed++;
  } catch (e) {
    console.log(`  [PASS] ${name} -> 已拒绝: ${e.message.slice(0, 50)}`);
    passed++;
  }
}

/**
 * 用给定的 info 对象与文件重新压制一个包，用于构造攻击样本
 */
function buildMaliciousZip(zipPath, infoObj, extraFiles = {}) {
  const infoJsonStr = JSON.stringify(infoObj, null, 2);
  const checksumLines = [`${md5String(infoJsonStr)}  info.json`];
  for (const [name, content] of Object.entries(extraFiles)) {
    checksumLines.push(`${md5String(content)}  ${name}`);
  }

  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    archive.append(infoJsonStr, { name: 'info.json' });
    archive.append(checksumLines.join('\n'), { name: 'checksum.txt' });
    for (const [name, content] of Object.entries(extraFiles)) {
      archive.append(content, { name });
    }
    archive.finalize();
  });
}

async function runTest() {
  console.log('=== VFusion 单元测试: 打包、解包与签名防篡改 ===');

  const testDir = path.join(__dirname, 'test_tmp');
  const outDir = path.join(testDir, 'out');

  if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  fs.mkdirSync(testDir, { recursive: true });

  const sampleImgPath = path.join(testDir, 'test_sample.jpg');
  fs.writeFileSync(sampleImgPath, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]));

  console.log('\n[1/4] 打包与签名回填');
  const packResult = await packEventPackage({
    outputDir: outDir,
    appId: 'sys_test',
    bizType: 'test_snapshot',
    eventId: 'EVT_TEST_1001',
    operator: 'Tester',
    payload: { location: '测试车间', threat_level: '高' },
    files: [{ path: sampleImgPath, filename: '001.jpg' }]
  });
  check('生成了 zip 文件', fs.existsSync(packResult.zipPath));
  check('info.json 已回填 64 位 HMAC 签名', /^[a-f0-9]{64}$/.test(packResult.info.signature || ''));

  console.log('\n[2/4] 正常包解包与校验');
  const unpackResult = await unpackAndVerifyPackage(packResult.zipPath, path.join(testDir, 'extract'));
  check('解包成功且 event_id 正确', unpackResult.info.event_id === 'EVT_TEST_1001');
  check('签名字段在解析结果中保留', unpackResult.info.signature === packResult.info.signature);

  console.log('\n[3/4] 篡改与伪造包必须被拒绝');

  // 攻击 A: 篡改 payload 但保留原签名
  const tamperedInfo = { ...packResult.info, payload: { location: '被篡改的地点' } };
  const tamperedZip = path.join(outDir, 'attack_tampered.zip');
  await buildMaliciousZip(tamperedZip, tamperedInfo);
  await expectReject('篡改 payload 后签名校验失败', () =>
    unpackAndVerifyPackage(tamperedZip, path.join(testDir, 'ex_a')));

  // 攻击 B: 完全自制的未签名包（signature 为空）
  const unsignedInfo = { ...packResult.info, signature: '', payload: { location: '伪造投放' } };
  const unsignedZip = path.join(outDir, 'attack_unsigned.zip');
  await buildMaliciousZip(unsignedZip, unsignedInfo);
  await expectReject('未签名的伪造包被拒绝', () =>
    unpackAndVerifyPackage(unsignedZip, path.join(testDir, 'ex_b')));

  // 攻击 C: 删除 signature 字段
  const noSigInfo = { ...packResult.info, payload: { location: '伪造投放' } };
  delete noSigInfo.signature;
  const noSigZip = path.join(outDir, 'attack_nosig.zip');
  await buildMaliciousZip(noSigZip, noSigInfo);
  await expectReject('缺失 signature 字段的包被拒绝', () =>
    unpackAndVerifyPackage(noSigZip, path.join(testDir, 'ex_c')));

  console.log('\n[4/4] 清理临时测试文件');
  fs.rmSync(testDir, { recursive: true, force: true });

  console.log(`\n=== 测试结果: ${passed} 通过, ${failed} 失败 ===`);
  if (failed > 0) process.exit(1);
  console.log('=== VFusion 单元测试全部通过！ ===');
}

runTest().catch(err => {
  console.error('测试执行异常:', err);
  process.exit(1);
});
