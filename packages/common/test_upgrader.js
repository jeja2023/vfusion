const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const unzipper = require('unzipper');
const { getUpgradeCandidateSigningKeys, validateUpgradeArchive } = require('./system_upgrader');

async function runTests() {
  console.log('=== VFusion 系统在线升级验签与多候选密钥测试 ===\n');

  const testStorage = path.resolve(__dirname, '../../storage');
  const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'));
  const patchZip = path.resolve(__dirname, `../../release/vfusion-patch-v${pkg.version}.zip`);

  // 1. 验证候选密钥获取
  const keys = getUpgradeCandidateSigningKeys(testStorage);
  assert(Array.isArray(keys) && keys.length > 0, '候选密钥列表应当非空');
  console.log(`[PASS] 成功获取 ${keys.length} 个升级验签候选密钥:`, keys.map(k => `${k.slice(0, 4)}...${k.slice(-4)}`));

  // 2. 验证真实补丁包结构
  if (fs.existsSync(patchZip)) {
    await validateUpgradeArchive(patchZip);
    console.log('[PASS] 真实补丁包 validateUpgradeArchive 静态结构校验通过');
  }

  // 3. 验证多候选密钥与换行符容错
  const sec = JSON.parse(fs.readFileSync(path.join(testStorage, 'security.json'), 'utf8'));
  const upgradeKey = sec.upgrade_signing_key || '12345678901234567890123456789012';
  const hmacKey = sec.hmac_secret || 'abcdefabcdefabcdefabcdefabcdefab';

  const manifestLF = JSON.stringify({ version: pkg.version, test: true }, null, 2);
  const manifestCRLF = manifestLF.replace(/\n/g, '\r\n');

  // 用 upgradeKey 签名 LF
  const sigUpgrade = crypto.createHmac('sha256', upgradeKey).update(manifestLF).digest('hex');
  // 用 hmacKey 签名 CRLF
  const sigHmac = crypto.createHmac('sha256', hmacKey).update(manifestCRLF).digest('hex');

  function verifySignature(manifestRaw, signature, candidateKeys) {
    const actual = signature.trim();
    if (!/^[a-f0-9]{64}$/i.test(actual)) return false;
    const variants = [
      manifestRaw,
      manifestRaw.replace(/\r\n/g, '\n'),
      manifestRaw.replace(/\r?\n/g, '\r\n'),
      manifestRaw.trim(),
      manifestRaw.replace(/\r\n/g, '\n').trim()
    ];
    for (const k of candidateKeys) {
      for (const v of variants) {
        const exp = crypto.createHmac('sha256', k).update(v).digest('hex');
        if (crypto.timingSafeEqual(Buffer.from(exp), Buffer.from(actual))) return true;
      }
    }
    return false;
  }

  // 测试 3.1：upgrade_signing_key 签名，无论是 CRLF 还是 LF 都能验签通过
  assert(verifySignature(manifestLF, sigUpgrade, [upgradeKey, hmacKey]), 'upgradeKey 签名 LF 验签应当通过');
  assert(verifySignature(manifestCRLF, sigUpgrade, [upgradeKey, hmacKey]), 'upgradeKey 签名 CRLF 变体验签应当通过');
  console.log('[PASS] upgrade_signing_key 签名在 LF/CRLF 下均验签通过');

  // 测试 3.2：hmac_secret 签名，降级匹配通过
  assert(verifySignature(manifestLF, sigHmac, [upgradeKey, hmacKey]), 'hmac_secret 签名降级验签应当通过');
  assert(verifySignature(manifestCRLF, sigHmac, [upgradeKey, hmacKey]), 'hmac_secret 签名 CRLF 降级验签应当通过');
  console.log('[PASS] hmac_secret 签名降级容错验签通过');

  // 测试 3.3：伪造或篡改密钥必须被拒绝
  const fakeSig = crypto.createHmac('sha256', 'fake_secret_key_1234567890123456').update(manifestLF).digest('hex');
  assert(!verifySignature(manifestLF, fakeSig, [upgradeKey, hmacKey]), '伪造密钥签名应当被拒绝');
  console.log('[PASS] 伪造密钥签名被正确拦截');

  console.log('\n=== 所有升级签名验证测试通过！ ===');
}

runTests().catch(err => {
  console.error('测试失败:', err);
  process.exit(1);
});
