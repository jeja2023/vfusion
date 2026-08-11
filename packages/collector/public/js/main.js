let currentUser = null;

// 统一转义：所有后端返回值在拼入 innerHTML 前必须经过此函数
function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getAuthToken() {
  return localStorage.getItem('vfusion_collector_token') || '';
}

const nativeFetch = window.fetch.bind(window);

async function apiFetch(url, options = {}) {
  const opts = { ...options };
  opts.headers = { ...(options.headers || {}) };
  const token = getAuthToken();
  if (token) opts.headers['Authorization'] = `Bearer ${token}`;

  const res = await nativeFetch(url, opts);
  if (res.status === 401 && !url.includes('/api/auth/login') && !url.includes('/api/schema')) {
    const wasLoggedIn = !!currentUser || !!token;
    localStorage.removeItem('vfusion_collector_token');
    localStorage.removeItem('vfusion_collector_user');
    currentUser = null;
    if (wasLoggedIn) {
      showToast('登录状态已过期，请重新登录', 'error');
      document.getElementById('loginOverlay').style.display = 'flex';
    }
  }
  return res;
}

const auditTypeMap = {
  'AUTH_SUCCESS': '用户登录',
  'AUTH_FAIL': '登录失败',
  'USER_ADD': '新增用户',
  'USER_PWD_RESET': '重置密码',
  'USER_DEL': '删除用户',
  'INGEST': '单据发布打包',
  'SCHEMA_UPDATE': 'Schema更新',
  'EXPORT_AUDIT': '导出日志',
  'ERROR': '错误'
};

const auditStatusMap = {
  'SUCCESS': '成功',
  'INFO': '信息',
  'WARN': '警告',
  'ERROR': '错误'
};

async function loadPageTemplates() {
  const pages = ['publish', 'history', 'builder', 'ftp', 'audits', 'users'];
  await Promise.all(pages.map(async (p) => {
    try {
      const res = await fetch(`pages/${p}.html`);
      if (res.ok) {
        const html = await res.text();
        const container = document.getElementById(`tab-${p}`);
        if (container) container.innerHTML = html;
      }
    } catch (e) {
      console.error(`加载页面模板 pages/${p}.html 失败:`, e);
    }
  }));
}

function openImageLightbox(url, caption) {
  document.getElementById('lightboxImg').src = url;
  document.getElementById('lightboxCaption').innerText = caption || '现场照片凭证';
  document.getElementById('imageLightboxOverlay').style.display = 'flex';
}

function closeImageLightbox() {
  document.getElementById('imageLightboxOverlay').style.display = 'none';
}

function showPersonDetailModal(encodedJson) {
  try {
    const p = JSON.parse(decodeURIComponent(encodedJson));
    document.getElementById('modalPersonName').innerText = p.person_name || '未填';
    document.getElementById('modalPersonIdCard').innerText = p.person_id_card || '未填';
    document.getElementById('modalPersonDomicile').innerText = p.person_domicile || '未填';
    document.getElementById('personDetailModal').style.display = 'flex';
  } catch (e) {}
}

function closePersonDetailModal() {
  document.getElementById('personDetailModal').style.display = 'none';
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeImageLightbox();
    closePersonDetailModal();
  }
});

function showToast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <svg class="icon-svg" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
    <span>${escapeHtml(message)}</span>
  `;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

async function checkAuth() {
  const storedUser = localStorage.getItem('vfusion_collector_user');
  if (storedUser) {
    currentUser = JSON.parse(storedUser);
    document.getElementById('loginOverlay').style.display = 'none';
    document.getElementById('userInfoTag').innerText = `${currentUser.name} (${currentUser.username})`;
    applyRolePermissions();
    if (typeof loadSchema === 'function') loadSchema();
  } else {
    document.getElementById('loginOverlay').style.display = 'flex';
  }
}

function applyRolePermissions() {
  if (!currentUser) return;
  const role = currentUser.role;

  if (role === 'operator') {
    document.getElementById('tabBtn-audits').style.display = 'none';
    document.getElementById('tabBtn-users').style.display = 'none';
  } else {
    document.getElementById('tabBtn-audits').style.display = 'inline-flex';
    document.getElementById('tabBtn-users').style.display = 'inline-flex';
  }
}

async function handleLogin(e) {
  e.preventDefault();
  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value.trim();

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const json = await res.json();
    if (json.success) {
      currentUser = json.data.user;
      localStorage.setItem('vfusion_collector_user', JSON.stringify(currentUser));
      localStorage.setItem('vfusion_collector_token', json.data.token);
      showToast(`登录成功！欢迎 ${currentUser.name}`);
      checkAuth();
    } else {
      showToast(json.error, 'error');
    }
  } catch (err) {
    showToast('登录请求失败: ' + err.message, 'error');
  }
}

function handleLogout() {
  localStorage.removeItem('vfusion_collector_user');
  localStorage.removeItem('vfusion_collector_token');
  currentUser = null;
  document.getElementById('loginOverlay').style.display = 'flex';
  showToast('已安全退出');
}

function switchTab(tabId) {
  document.querySelectorAll('.nav-item, .tab-btn').forEach(btn => btn.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  if (event && event.currentTarget) event.currentTarget.classList.add('active');
  const targetTab = document.getElementById(tabId);
  if (targetTab) targetTab.classList.add('active');

  if (tabId === 'tab-publish' && typeof loadSchema === 'function') loadSchema();
  if (tabId === 'tab-history' && typeof loadPublishedHistory === 'function') loadPublishedHistory();
  if (tabId === 'tab-builder' && typeof loadSchema === 'function') loadSchema();
  if (tabId === 'tab-ftp' && typeof loadCollectorFtpConfig === 'function') loadCollectorFtpConfig();
  if (tabId === 'tab-audits' && typeof loadFullAuditLogs === 'function') loadFullAuditLogs();
  if (tabId === 'tab-users' && typeof loadUsers === 'function') loadUsers();
}

window.addEventListener('DOMContentLoaded', async () => {
  await loadPageTemplates();
  bindPublishFormSubmit();
  await checkAuth();
  if (typeof loadSchema === 'function') await loadSchema();
});
