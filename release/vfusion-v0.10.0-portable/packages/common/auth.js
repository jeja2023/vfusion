const crypto = require('crypto');

/**
 * SHA-256 密码加盐哈希
 */
function hashPassword(password) {
  const salt = 'vfusion_rbac_salt_2026';
  return crypto.createHash('sha256').update(password + salt).digest('hex');
}

/**
 * 预设内置账号列表
 */
const DEFAULT_USERS = [
  {
    id: 101,
    username: 'admin',
    name: '系统超级管理员',
    password: hashPassword('admin123'),
    role: 'admin', // 超级管理员
    status: 'ACTIVE',
    created_at: new Date().toISOString()
  },
  {
    id: 102,
    username: 'operator',
    name: '视频网业务操作员',
    password: hashPassword('op123'),
    role: 'operator', // 业务操作员
    status: 'ACTIVE',
    created_at: new Date().toISOString()
  },
  {
    id: 103,
    username: 'auditor',
    name: '安全合规审计员',
    password: hashPassword('audit123'),
    role: 'auditor', // 安全审计员
    status: 'ACTIVE',
    created_at: new Date().toISOString()
  }
];

function generateToken(user) {
  const payload = {
    id: user.id,
    username: user.username,
    role: user.role,
    time: Date.now()
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

function verifyToken(tokenStr) {
  try {
    const jsonStr = Buffer.from(tokenStr, 'base64').toString('utf8');
    return JSON.parse(jsonStr);
  } catch (e) {
    return null;
  }
}

module.exports = {
  hashPassword,
  DEFAULT_USERS,
  generateToken,
  verifyToken
};
