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
  // 身份与用户管理
  'AUTH_SUCCESS': '用户登录成功',
  'AUTH_FAIL': '用户登录失败',
  'USER_ADD': '新增用户账号',
  'USER_UPDATE': '修改用户信息',
  'USER_DEL': '删除用户账号',
  'USER_PWD_RESET': '重置用户密码',
  'USER_PWD_UPGRADE': '升级密码安全加密',

  // 数据发布与单据处理
  'INGEST': '单据发布打包',
  'SCANNER': '摆渡目录自动扫描',
  'IDEMPOTENCY': '幂等去重归档',
  'DIODE_SIM': '网闸模拟摆渡',
  'DIODE_CONFIG': '摆渡频率配置',
  'DOWNLOAD': '现场存照附件下载',

  // 任务管理与图片维护
  'TASK_CREATE': '创建巡检任务',
  'TASK_EDIT': '修改任务信息',
  'TASK_DELETE': '删除任务与单据',
  'TASK_STATUS': '变更任务执行状态',
  'TASK_SHARE_UPDATE': '更新任务共享码',
  'TASK_IMAGE_EDIT': '编辑照片描述与坐标',
  'TASK_IMAGE_DELETE': '删除任务现场照片',

  // 监控点位主数据
  'MONITORING_POINT_ADD': '新增监控点位',
  'MONITORING_POINT_UPDATE': '修改监控点位',
  'MONITORING_POINT_TOGGLE': '启停监控点位',
  'MONITORING_POINT_IMPORT': '批量导入监控点位',

  // 涉事人员档案
  'PERSONNEL_EDIT': '修改人员档案',
  'PERSONNEL_DELETE': '删除人员档案',

  // 表单设计器
  'SCHEMA_UPDATE': '动态表单Schema更新',

  // FTP 传输通道
  'FTP_CONFIG': 'FTP通道参数配置',
  'FTP_POLL': 'FTP远程自动轮询',
  'FTP_PULL': 'FTP手动拉取数据',
  'FTP_UPLOAD': 'FTP数据包自动推送',
  'FTP_TEST': 'FTP通道连通性测试',

  // Webhook 消息分发 (内网中台)
  'WEBHOOK': 'Webhook消息推送',
  'WEBHOOK_ADD': '新增Webhook订阅',
  'WEBHOOK_UPDATE': '修改Webhook配置',
  'WEBHOOK_DEL': '移除Webhook订阅',
  'WEBHOOK_TEST': 'Webhook连通性测试',
  'WEBHOOK_SECRET_ROTATE': 'Webhook签名密钥轮换',

  // 系统安全与地图运维
  'MAP_CONFIG': '离线地图参数配置',
  'SECURITY': '安全秘钥在线轮换',
  'SYSTEM_UPGRADE': '系统在线无损热升级',
  'CLEANUP': '清理历史归档数据',
  'DIAGNOSE': '系统运行状态诊断',
  'EXPORT_AUDIT': '导出系统审计日志',
  'SYSTEM': '系统核心服务就绪',
  'ERROR': '系统异常与错误'
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
  if (imgEl) imgEl.src = typeof assetUrl === 'function' ? assetUrl(url) : url;

  if (captionEl) {
    if (typeof captionData === 'object' && captionData !== null) {
      const { description, timestamp, location, uploader, longitude, latitude } = captionData;
      const descHtml = description
        ? `<div style="font-size:0.875rem; font-weight:600; color:#1e293b; background:#f8fafc; padding:0.45rem 0.85rem; border-radius:6px; border:1px solid #e2e8f0; margin-bottom:0.35rem; text-align:left; width:100%;">${escapeHtml(description)}</div>`
        : '';

      const metaParts = [];
      if (timestamp) {
        metaParts.push(`<span style="display:inline-flex; align-items:center; gap:0.3rem; color:#334155; font-size:0.825rem;"><svg class="icon-svg" viewBox="0 0 24 24" style="width:15px; height:15px; color:#0284c7;"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg><strong>时间:</strong> <span style="color:#0f172a;">${escapeHtml(timestamp)}</span></span>`);
      }
      if (location) {
        metaParts.push(`<span style="display:inline-flex; align-items:center; gap:0.3rem; color:#334155; font-size:0.825rem;"><svg class="icon-svg" viewBox="0 0 24 24" style="width:15px; height:15px; color:#0284c7;"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg><strong>地点:</strong> <span style="color:#0f172a; font-weight:600;">${escapeHtml(location)}</span></span>`);
      }
      const lng = longitude !== undefined && longitude !== null && longitude !== '' ? parseFloat(longitude) : null;
      const lat = latitude !== undefined && latitude !== null && latitude !== '' ? parseFloat(latitude) : null;
      if (lng !== null && !isNaN(lng) && lat !== null && !isNaN(lat)) {
        metaParts.push(`<span style="display:inline-flex; align-items:center; gap:0.3rem; color:#334155; font-size:0.825rem;"><svg class="icon-svg" viewBox="0 0 24 24" style="width:15px; height:15px; color:#16a34a;"><circle cx="12" cy="12" r="9"/><line x1="12" y1="3" x2="12" y2="7"/><line x1="12" y1="17" x2="12" y2="21"/><line x1="3" y1="12" x2="7" y2="12"/><line x1="17" y1="12" x2="21" y2="12"/></svg><strong>经纬度:</strong> <code style="background:#ecfdf5; border:1px solid #a7f3d0; color:#065f46; padding:2px 6px; border-radius:4px; font-weight:700; font-family:monospace; font-size:0.8rem;">${lng.toFixed(6)}, ${lat.toFixed(6)}</code></span>`);
      }
      if (uploader) {
        metaParts.push(`<span style="display:inline-flex; align-items:center; gap:0.3rem; color:#334155; font-size:0.825rem;"><svg class="icon-svg" viewBox="0 0 24 24" style="width:15px; height:15px; color:#64748b;"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg><strong>提交人:</strong> <span style="color:#0f172a;">${escapeHtml(uploader)}</span></span>`);
      }

      captionEl.innerHTML = `
        <div style="display:flex; flex-direction:column; align-items:center; gap:0.35rem; width:100%;">
          ${descHtml}
          <div style="display:flex; flex-wrap:wrap; justify-content:center; align-items:center; gap:1.25rem;">
            ${metaParts.join('')}
          </div>
        </div>
      `;
    } else {
      captionEl.innerHTML = `<div style="font-size:0.875rem; font-weight:600; color:#1e293b; text-align:center;">${escapeHtml(captionData || '现场照片')}</div>`;
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
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;

  let iconSvg = '<svg class="icon-svg" viewBox="0 0 24 24" style="width:16px;height:16px;"><polyline points="20 6 9 17 4 12"/></svg>';
  if (type === 'error') {
    iconSvg = '<svg class="icon-svg" viewBox="0 0 24 24" style="width:16px;height:16px;"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';
  } else if (type === 'warn' || type === 'warning') {
    iconSvg = '<svg class="icon-svg" viewBox="0 0 24 24" style="width:16px;height:16px;"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
  }

  toast.innerHTML = `
    ${iconSvg}
    <span>${escapeHtml(message)}</span>
  `;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.transition = 'all 0.25s ease';
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(-10px) scale(0.96)';
    setTimeout(() => toast.remove(), 250);
  }, 3000);
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
      titleEl.innerHTML = `<a href="#" data-action="event.preventDefault(); switchTab('tab-tasks')" style="color:var(--text-muted); text-decoration:none; transition:color 0.15s;" data-action-mouseover="this.style.color='var(--primary)'" data-action-mouseout="this.style.color='var(--text-muted)'">任务管理中心</a> <span style="color:#cbd5e1; margin:0 0.35rem;">/</span> <span style="color:var(--primary); font-weight:700;">任务现场图片库</span>`;
    } else if (tabId === 'tab-publish') {
      titleEl.innerHTML = `<a href="#" data-action="event.preventDefault(); switchTab('tab-tasks')" style="color:var(--text-muted); text-decoration:none; transition:color 0.15s;" data-action-mouseover="this.style.color='var(--primary)'" data-action-mouseout="this.style.color='var(--text-muted)'">任务管理中心</a> <span style="color:#cbd5e1; margin:0 0.35rem;">/</span> <span style="color:var(--primary); font-weight:700;">上传现场图片</span>`;
    } else if (pageTitles[tabId]) {
      titleEl.innerText = pageTitles[tabId];
    }
  }

  if (tabId === 'tab-tasks' && typeof loadTaskList === 'function') loadTaskList();
  if (tabId === 'tab-task-images' && typeof initTaskImagesPage === 'function') initTaskImagesPage();
  if (tabId === 'tab-publish' && typeof initPublishPage === 'function') initPublishPage();
  if (tabId === 'tab-history' && typeof loadPublishedHistory === 'function') loadPublishedHistory();
  if (tabId === 'tab-builder' && typeof loadSchema === 'function') loadSchema();
  if (tabId === 'tab-ftp' && typeof loadCollectorFtpConfig === 'function') loadCollectorFtpConfig();
  if (tabId === 'tab-audits') {
    if (typeof loadFullAuditLogs === 'function') loadFullAuditLogs();
    else if (typeof loadAuditLogs === 'function') loadAuditLogs();
  }
  if (tabId === 'tab-users' && typeof loadUsers === 'function') loadUsers();
  if (tabId === 'tab-system' && typeof loadCollectorSystemConfig === 'function') loadCollectorSystemConfig();
}

document.addEventListener('DOMContentLoaded', async () => {
  await loadPageTemplates();
  await checkAuth();
});

Object.assign(window.VFusionActions = window.VFusionActions || {}, {
  checkAuth, handleLogin, handleLogout, switchTab, openImageLightbox, closeImageLightbox,
  showPersonDetailModal, closePersonDetailModal, showToast
});
