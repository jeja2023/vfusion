const crypto = require('crypto');
const { generateToken, verifyToken, setTokenSecret, getTokenSecret } = require('./auth_middleware');

/**
 * 密码哈希：PBKDF2-SHA256 + 每用户随机盐
 * 存储格式: pbkdf2$<iterations>$<saltHex>$<hashHex>
 *
 * 旧版本使用固定盐的单轮 SHA-256（格式为 64 位裸 hex），
 * verifyPassword 仍可校验旧格式以便平滑迁移，但新密码一律写入新格式。
 */
const PBKDF2_ITERATIONS = 120000;
const LEGACY_SALT = 'vfusion_rbac_salt_2026';

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, 32, 'sha256');
  return `pbkdf2$${PBKDF2_ITERATIONS}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

/**
 * 旧格式（固定盐单轮 SHA-256）哈希，仅用于兼容校验历史数据
 */
function legacyHashPassword(password) {
  return crypto.createHash('sha256').update(password + LEGACY_SALT).digest('hex');
}

function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * 校验密码，同时兼容新旧两种存储格式
 * @returns {{ valid: boolean, needsUpgrade: boolean }}
 */
function verifyPassword(password, stored) {
  if (typeof stored !== 'string' || stored.length === 0) {
    return { valid: false, needsUpgrade: false };
  }

  if (stored.startsWith('pbkdf2$')) {
    const [, iterStr, saltHex, hashHex] = stored.split('$');
    const iterations = parseInt(iterStr, 10);
    if (!iterations || !saltHex || !hashHex) return { valid: false, needsUpgrade: false };
    const computed = crypto.pbkdf2Sync(password, Buffer.from(saltHex, 'hex'), iterations, 32, 'sha256');
    return { valid: timingSafeEqualStr(computed.toString('hex'), hashHex), needsUpgrade: false };
  }

  // 兼容旧格式：校验通过后提示调用方升级为 PBKDF2
  const valid = timingSafeEqualStr(legacyHashPassword(password), stored);
  return { valid, needsUpgrade: valid };
}

/**
 * 预设内置账号列表。
 * 初始密码通过环境变量注入，未设置时生成随机密码并在首启日志中打印一次，
 * 避免固定弱口令随源码分发。
 */
function buildDefaultUsers() {
  const generated = {};
  const resolvePwd = (envKey, account) => {
    const fromEnv = process.env[envKey];
    if (fromEnv) return fromEnv;
    const random = crypto.randomBytes(9).toString('base64url');
    generated[account] = random;
    return random;
  };

  const adminUsername = process.env.VFUSION_ADMIN_USERNAME || 'admin';

  const users = [
    {
      id: 101,
      username: adminUsername,
      name: '系统超级管理员',
      password: hashPassword(resolvePwd('VFUSION_ADMIN_PASSWORD', adminUsername)),
      role: 'admin',
      status: 'ACTIVE',
      created_at: new Date().toISOString()
    }
  ];

  if (Object.keys(generated).length > 0) {
    console.log('\n==================== VFusion 内网端初始账号 ====================');
    console.log(` 检测到首次初始化，已为超级管理员 [${adminUsername}] 账号生成随机初始密码。`);
    console.log(' 请立即登录并修改，此密码仅显示这一次：');
    for (const [account, pwd] of Object.entries(generated)) {
      console.log(`   ${account.padEnd(10)} : ${pwd}`);
    }
    console.log(' 也可通过环境变量预设: VFUSION_ADMIN_USERNAME 与 VFUSION_ADMIN_PASSWORD');
    console.log(' 其他业务/审计账号请在登录控制台后由管理员账号手动创建。');
    console.log('=================================================================\n');
  }

  return users;
}

module.exports = {
  hashPassword,
  verifyPassword,
  legacyHashPassword,
  buildDefaultUsers,
  generateToken,
  verifyToken,
  setTokenSecret,
  getTokenSecret
};
