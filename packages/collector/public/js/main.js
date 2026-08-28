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

function escapeJsString(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\&#39;")
    .replace(/"/g, '&quot;')
    .replace(/\r?\n/g, '\\n');
}

function formatUserForTable(val, nameFallback) {
  if (nameFallback && String(nameFallback).trim()) return String(nameFallback).trim();
  if (!val) return '操作员';
  let str = String(val).trim();
  const match = str.match(/^([^(]+)\s*\(([^)]+)\)$/);
  if (match) {
    const p1 = match[1].trim();
    const p2 = match[2].trim();
    if (/[\u4e00-\u9fa5]/.test(p1)) return p1;
    if (/[\u4e00-\u9fa5]/.test(p2)) return p2;
    return p1;
  }
  const matchReverse = str.match(/^([a-zA-Z0-9_-]+)\s*\(([^)]+)\)$/);
  if (matchReverse) {
    const p2 = matchReverse[2].trim();
    if (p2) return p2;
  }
  if (str === 'admin') return '管理员';
  if (str === 'operator') return '视频网操作员';
  return str;
}

function formatUserWithRealName(username, realName) {
  const u = (username || '').trim();
  const r = (realName || '').trim();
  if (u && r && u !== r) {
    return `${u} (${r})`;
  }
  if (u) return u;
  if (r) return r;
  return '操作员';
}

function getAuthToken() {
  return localStorage.getItem('vfusion_collector_token') || '';
}

function assetUrl(url) {
  let value = String(url || '');
  if (!/^\/(?:assets|collector-assets)\//.test(value)) return value;
  const token = localStorage.getItem('vfusion_collector_asset_token') || localStorage.getItem('vfusion_collector_token') || '';
  if (!token) return value;
  try {
    const origin = (typeof window !== 'undefined' && window.location && window.location.origin) ? window.location.origin : 'http://localhost';
    const parsed = new URL(value, origin);
    parsed.searchParams.set('access_token', token);
    return `${parsed.pathname}${parsed.search}`;
  } catch (e) {
    const cleanBase = value.split('?')[0];
    return `${cleanBase}?access_token=${encodeURIComponent(token)}`;
  }
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
      const overlay = document.getElementById('loginOverlay');
      if (overlay) overlay.style.display = 'flex';
    }
  }
  return res;
}

// 全局拦截：让各页面已有的 fetch('/api/...') 调用自动携带 Token 并统一处理登录态失效
window.fetch = function (input, init) {
  const url = typeof input === 'string' ? input : (input && input.url) || '';
  if (!url.startsWith('/api/') || url.startsWith('/api/auth/login')) {
    return nativeFetch(input, init);
  }
  return apiFetch(url, init || {});
};

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
  const pages = [
    { file: 'tasks', id: 'tab-tasks' },
    { file: 'task_images', id: 'tab-task-images' },
    { file: 'publish', id: 'tab-publish' },
    { file: 'history', id: 'tab-history' },
    { file: 'builder', id: 'tab-builder' },
    { file: 'ftp', id: 'tab-ftp' },
    { file: 'audits', id: 'tab-audits' },
    { file: 'users', id: 'tab-users' },
    { file: 'system', id: 'tab-system' }
  ];
  await Promise.all(pages.map(async (p) => {
    try {
      const res = await fetch(`pages/${p.file}.html?v=${Date.now()}`);
      if (res.ok) {
        const html = await res.text();
        const container = document.getElementById(p.id);
        if (container) container.innerHTML = html;
      }
    } catch (e) {
      console.error(`加载页面模板 pages/${p.file}.html 失败:`, e);
    }
  }));
}

function openImageLightbox(url, captionData) {
  const imgEl = document.getElementById('lightboxImg');
  const captionEl = document.getElementById('lightboxCaption');
  if (imgEl) imgEl.src = assetUrl(url);

  if (captionEl) {
    if (typeof captionData === 'object' && captionData !== null) {
      const { description, timestamp, location, uploader } = captionData;
      const descHtml = description
        ? `<div style="font-size:0.9rem; font-weight:600; color:#1e293b; background:#f1f5f9; padding:0.55rem 0.85rem; border-radius:8px; border:1px solid #e2e8f0; margin-bottom:0.4rem; text-align:left; width:100%;">${escapeHtml(description)}</div>`
        : `<div style="font-size:0.85rem; color:#94a3b8; font-style:italic; margin-bottom:0.4rem;">(暂无图片描述)</div>`;
      
      const metaParts = [];
      if (timestamp) metaParts.push(`<span style="display:inline-flex; align-items:center; gap:0.25rem;"><svg class="icon-svg" viewBox="0 0 24 24" style="width:14px; height:14px; color:#0284c7;"><circle cx="12" cy="10" r="10"/><polyline points="12 6 12 12 16 14"/></svg><strong>时间:</strong> ${escapeHtml(timestamp)}</span>`);
      if (location) metaParts.push(`<span style="display:inline-flex; align-items:center; gap:0.25rem;"><svg class="icon-svg" viewBox="0 0 24 24" style="width:14px; height:14px; color:#0284c7;"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg><strong>地点:</strong> ${escapeHtml(location)}</span>`);
      if (uploader) metaParts.push(`<span style="display:inline-flex; align-items:center; gap:0.25rem;"><svg class="icon-svg" viewBox="0 0 24 24" style="width:14px; height:14px; color:#0284c7;"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg><strong>提交人:</strong> ${escapeHtml(uploader)}</span>`);

      captionEl.innerHTML = `
        <div style="display:flex; flex-direction:column; align-items:center; gap:0.25rem; width:100%; max-width:680px; margin-top:0.5rem;">
          ${descHtml}
          <div style="display:flex; flex-wrap:wrap; justify-content:center; gap:1.25rem; font-size:0.8rem; color:#475569;">
            ${metaParts.join('')}
          </div>
        </div>
      `;
    } else {
      captionEl.innerHTML = `<span style="font-size:0.875rem; font-weight:600; color:var(--text-main);">${escapeHtml(captionData || '现场照片')}</span>`;
    }
  }
  const overlay = document.getElementById('imageLightboxOverlay');
  if (overlay) overlay.style.display = 'flex';
}

function closeImageLightbox() {
  const overlay = document.getElementById('imageLightboxOverlay');
  if (overlay) overlay.style.display = 'none';
}

function showPersonDetailModal(encodedJson) {
  try {
    const p = JSON.parse(decodeURIComponent(encodedJson));
    const nameEl = document.getElementById('modalPersonName');
    const idCardEl = document.getElementById('modalPersonIdCard');
    const domicileEl = document.getElementById('modalPersonDomicile');
    const modalEl = document.getElementById('personDetailModal');
    if (nameEl) nameEl.innerText = p.person_name || '未填';
    if (idCardEl) idCardEl.innerText = p.person_id_card || '未填';
    if (domicileEl) domicileEl.innerText = p.person_domicile || '未填';
    if (modalEl) modalEl.style.display = 'flex';
  } catch (e) {}
}

function closePersonDetailModal() {
  const modalEl = document.getElementById('personDetailModal');
  if (modalEl) modalEl.style.display = 'none';
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeImageLightbox();
    closePersonDetailModal();
  }
});

function showToast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  if (!container) return;
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
  const storedToken = localStorage.getItem('vfusion_collector_token');
  if (!storedUser || !storedToken) {
    currentUser = null;
    const overlay = document.getElementById('loginOverlay');
    if (overlay) overlay.style.display = 'flex';
    return;
  }

  try {
    const meRes = await apiFetch('/api/auth/me');
    const meJson = await meRes.json();
    if (!meJson.success || !meJson.data) {
      throw new Error('鉴权无效');
    }
    currentUser = meJson.data;
    localStorage.setItem('vfusion_collector_user', JSON.stringify(currentUser));

    const tokenRes = await apiFetch('/api/auth/asset-token');
    const tokenJson = await tokenRes.json();
    if (tokenJson.success && tokenJson.data && tokenJson.data.token) {
      localStorage.setItem('vfusion_collector_asset_token', tokenJson.data.token);
      setTimeout(() => checkAuth(), Math.max(30_000, (tokenJson.data.expires_in - 30) * 1000));
    }
  } catch (e) {
    currentUser = null;
    localStorage.removeItem('vfusion_collector_token');
    localStorage.removeItem('vfusion_collector_user');
    localStorage.removeItem('vfusion_collector_asset_token');
    const overlay = document.getElementById('loginOverlay');
    if (overlay) overlay.style.display = 'flex';
    return;
  }

  const overlay = document.getElementById('loginOverlay');
  if (overlay) overlay.style.display = 'none';
  const userInfoTag = document.getElementById('userInfoTag');
  if (userInfoTag) userInfoTag.innerText = formatUserWithRealName(currentUser.username, currentUser.name);
  applyRolePermissions();
  if (typeof loadSchema === 'function') loadSchema();
  if (typeof loadTaskList === 'function') loadTaskList();

  // 刷新恢复上次访问的页面 Tab
  const hashTab = location.hash ? location.hash.replace('#', '') : '';
  const savedTab = hashTab || localStorage.getItem('vfusion_collector_active_tab') || 'tab-tasks';
  if (savedTab && document.getElementById(savedTab)) {
    switchTab(savedTab);
  } else {
    switchTab('tab-tasks');
  }
}

function applyRolePermissions() {
  if (!currentUser) return;
  const isAdmin = currentUser.role === 'admin';

  const builderBtn = document.getElementById('tabBtn-builder');
  const ftpBtn = document.getElementById('tabBtn-ftp');
  const auditsBtn = document.getElementById('tabBtn-audits');
  const usersBtn = document.getElementById('tabBtn-users');
  const systemBtn = document.getElementById('tabBtn-system');

  if (builderBtn) builderBtn.style.display = isAdmin ? 'inline-flex' : 'none';
  if (ftpBtn) ftpBtn.style.display = isAdmin ? 'inline-flex' : 'none';
  if (auditsBtn) auditsBtn.style.display = isAdmin ? 'inline-flex' : 'none';
  if (usersBtn) usersBtn.style.display = isAdmin ? 'inline-flex' : 'none';
  if (systemBtn) systemBtn.style.display = isAdmin ? 'inline-flex' : 'none';

  if (!isAdmin && ['tab-builder', 'tab-ftp', 'tab-audits', 'tab-users', 'tab-system'].includes(currentTab)) {
    switchTab('tab-tasks');
  }
}

async function handleLogin(e) {
  e.preventDefault();
  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value.trim();

  try {
    const res = await nativeFetch('/api/auth/login', {
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
      await checkAuth();
    } else {
      showToast(json.error || json.message || '登录失败', 'error');
    }
  } catch (err) {
    showToast('登录请求失败: ' + err.message, 'error');
  }
}

function handleLogout() {
  localStorage.removeItem('vfusion_collector_user');
  localStorage.removeItem('vfusion_collector_token');
  localStorage.removeItem('vfusion_collector_asset_token');
  currentUser = null;
  const overlay = document.getElementById('loginOverlay');
  if (overlay) overlay.style.display = 'flex';
  showToast('已安全退出');
}

function switchTab(tabId) {
  if (!tabId || !document.getElementById(tabId)) tabId = 'tab-tasks';

  document.querySelectorAll('.nav-item, .tab-btn').forEach(btn => btn.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  if (typeof event !== 'undefined' && event && event.currentTarget && event.currentTarget.classList) {
    event.currentTarget.classList.add('active');
  }
  const targetTab = document.getElementById(tabId);
  if (targetTab) targetTab.classList.add('active');

  const navBtnId = tabId.replace('tab-', 'tabBtn-');
  const navBtn = document.getElementById(navBtnId);
  if (navBtn) {
    navBtn.classList.add('active');
  } else if (tabId === 'tab-task-images' || tabId === 'tab-publish') {
    const tasksNavBtn = document.getElementById('tabBtn-tasks');
    if (tasksNavBtn) tasksNavBtn.classList.add('active');
  }

  // 保存当前 Active Tab 到 Hash 与 LocalStorage，实现刷新页面后保留在当前 Tab
  try {
    if (location.hash !== '#' + tabId) {
      history.replaceState(null, '', '#' + tabId);
    }
    localStorage.setItem('vfusion_collector_active_tab', tabId);
  } catch (e) {}

  const pageTitles = {
    'tab-tasks': '任务管理中心',
    'tab-task-images': '任务图片库',
    'tab-publish': '上传图片',
    'tab-history': '已提交历史存照',
    'tab-builder': '视频网表单设计器',
    'tab-ftp': 'FTP 通道配置',
    'tab-audits': '系统审计日志',
    'tab-users': '用户与权限管理',
    'tab-system': '系统配置与维护'
  };
  const titleEl = document.getElementById('currentPageTitle');
  if (titleEl) {
    if (tabId === 'tab-task-images') {
      titleEl.innerHTML = `<a href="javascript:void(0)" onclick="switchTab('tab-tasks')" style="color:var(--text-muted); text-decoration:none; transition:color 0.15s;" onmouseover="this.style.color='var(--primary)'" onmouseout="this.style.color='var(--text-muted)'">任务管理中心</a> <span style="color:#cbd5e1; margin:0 0.35rem;">/</span> <span style="color:var(--primary); font-weight:700;">任务现场图片库</span>`;
    } else if (tabId === 'tab-publish') {
      titleEl.innerHTML = `<a href="javascript:void(0)" onclick="switchTab('tab-tasks')" style="color:var(--text-muted); text-decoration:none; transition:color 0.15s;" onmouseover="this.style.color='var(--primary)'" onmouseout="this.style.color='var(--text-muted)'">任务管理中心</a> <span style="color:#cbd5e1; margin:0 0.35rem;">/</span> <span style="color:var(--primary); font-weight:700;">上传现场图片</span>`;
    } else if (pageTitles[tabId]) {
      titleEl.innerText = pageTitles[tabId];
    }
  }

  if (tabId === 'tab-tasks' && typeof loadTaskList === 'function') loadTaskList();
  if (tabId === 'tab-task-images' && typeof initTaskImagesPage === 'function') initTaskImagesPage();
  if (tabId === 'tab-history' && typeof loadPublishedHistory === 'function') loadPublishedHistory();
  if (tabId === 'tab-builder' && typeof loadSchema === 'function') loadSchema();
  if (tabId === 'tab-ftp' && typeof loadCollectorFtpConfig === 'function') loadCollectorFtpConfig();
  if (tabId === 'tab-audits' && typeof loadAuditLogs === 'function') loadAuditLogs();
  if (tabId === 'tab-users' && typeof loadUsers === 'function') loadUsers();
  if (tabId === 'tab-system' && typeof loadSystemInfo === 'function') loadSystemInfo();
}

document.addEventListener('DOMContentLoaded', async () => {
  await loadPageTemplates();
  await checkAuth();
});
