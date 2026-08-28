let currentUser = null;
let eventsData = [];
let auditLogs = [];
let currentSchema = { fields: [] };

// 转义后端回传文本，避免拼接进 innerHTML 时形成存储型 XSS
function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 用于嵌入 onclick="fn('...')" 这类内联属性的字符串字面量
function escapeJsString(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\&#39;")
    .replace(/"/g, '&quot;')
    .replace(/</g, '\\u003c')
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
  return localStorage.getItem('vfusion_token') || '';
}

function assetUrl(url) {
  let value = String(url || '');
  if (!/^\/(?:assets|collector-assets)\//.test(value)) return value;
  const token = localStorage.getItem('vfusion_core_asset_token') || localStorage.getItem('vfusion_token') || '';
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

// 保留原生实现，供 apiFetch 与静态资源请求使用，避免下方全局拦截造成递归
const nativeFetch = window.fetch.bind(window);

// 所有 /api 请求统一携带 Token；遇到 401/403 自动回到登录态
async function apiFetch(url, options = {}) {
  const opts = { ...options };
  opts.headers = { ...(options.headers || {}) };
  const token = getAuthToken();
  if (token) opts.headers['Authorization'] = `Bearer ${token}`;

  const res = await nativeFetch(url, opts);
  if (res.status === 401) {
    const wasLoggedIn = !!currentUser || !!token;
    localStorage.removeItem('vfusion_token');
    localStorage.removeItem('vfusion_user');
    localStorage.removeItem('vfusion_core_asset_token');
    currentUser = null;

    if (wasLoggedIn) {
      showToast('登录状态已过期，请重新登录', 'error');
      const overlay = document.getElementById('loginOverlay');
      if (overlay) overlay.style.display = 'flex';
    }
    throw new Error('未认证或登录状态已过期');
  }
  if (res.status === 403) {
    showToast('当前账号无权执行该操作', 'error');
    throw new Error('权限不足');
  }
  return res;
}

// 全局拦截：让各页面已有的 fetch('/api/...') 调用自动携带 Token 并统一处理登录态失效
window.fetch = function (input, init) {
  const url = typeof input === 'string' ? input : (input && input.url) || '';
  // 登录接口的 401 表示凭据错误，需交由登录表单提示，不能触发"登录态失效"重载
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
  'INGEST': '事件入库',
  'SCANNER': '目录扫描',
  'IDEMPOTENCY': '幂等归档',
  'DIODE_SIM': '网闸摆渡',
  'DIODE_CONFIG': '摆渡配置',
  'SCHEMA_UPDATE': 'Schema更新',
  'WEBHOOK': '消息分发',
  'WEBHOOK_ADD': '注册订阅',
  'WEBHOOK_DEL': '移除订阅',
  'SECURITY': '秘钥轮换',
  'DIAGNOSE': '在线诊断',
  'DOWNLOAD': '存照下载',
  'EXPORT_AUDIT': '导出日志',
  'CLEANUP': '清理归档',
  'ERROR': '解析错误'
};

const auditStatusMap = {
  'SUCCESS': '成功',
  'INFO': '信息',
  'WARN': '警告',
  'ERROR': '错误'
};

async function loadPageTemplates() {
  const pages = ['events', 'builder', 'ftp', 'webhooks', 'audits', 'personnel', 'users', 'errors', 'system'];
  await Promise.all(pages.map(async (p) => {
    try {
      const res = await fetch(`pages/${p}.html?v=${Date.now()}`);
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

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeDrawer();
    closeImageLightbox();
    closePersonDetailModal();
  }
});

function openImageLightbox(url, captionData) {
  const overlay = document.getElementById('imageLightboxOverlay');
  const img = document.getElementById('lightboxImg');
  const captionEl = document.getElementById('lightboxCaption');
  if (img) img.src = assetUrl(url);

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
    if (nameEl) nameEl.innerText = p.person_name || '未知';
    if (idCardEl) idCardEl.innerText = p.person_id_card || '未填';
    if (domicileEl) domicileEl.innerText = p.person_domicile || '未填';
    if (modalEl) modalEl.style.display = 'flex';
  } catch (e) { console.error('解析涉事人员信息失败:', e); }
}

function closePersonDetailModal() {
  const modalEl = document.getElementById('personDetailModal');
  if (modalEl) modalEl.style.display = 'none';
}

async function checkAuth() {
  const storedUser = localStorage.getItem('vfusion_user');
  const storedToken = localStorage.getItem('vfusion_token');
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
    localStorage.setItem('vfusion_user', JSON.stringify(currentUser));

    const tokenRes = await apiFetch('/api/auth/asset-token');
    const tokenJson = await tokenRes.json();
    if (tokenJson.success && tokenJson.data && tokenJson.data.token) {
      localStorage.setItem('vfusion_core_asset_token', tokenJson.data.token);
      setTimeout(() => checkAuth(), Math.max(30_000, (tokenJson.data.expires_in - 30) * 1000));
    }
  } catch (e) {
    currentUser = null;
    localStorage.removeItem('vfusion_token');
    localStorage.removeItem('vfusion_user');
    localStorage.removeItem('vfusion_core_asset_token');
    const overlay = document.getElementById('loginOverlay');
    if (overlay) overlay.style.display = 'flex';
    return;
  }

  const overlay = document.getElementById('loginOverlay');
  if (overlay) overlay.style.display = 'none';
  const userInfoTag = document.getElementById('userInfoTag');
  if (userInfoTag) userInfoTag.innerText = formatUserWithRealName(currentUser.username, currentUser.name);
  applyRolePermissions();
  if (typeof fetchData === 'function') fetchData();
  loadAlerts();

  // 刷新恢复上次访问的页面 Tab
  const hashTab = location.hash ? location.hash.replace('#', '') : '';
  const savedTab = hashTab || localStorage.getItem('vfusion_core_active_tab') || 'tab-events';
  if (savedTab && document.getElementById(savedTab)) {
    switchTab(savedTab);
  } else {
    switchTab('tab-events');
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
      localStorage.setItem('vfusion_user', JSON.stringify(currentUser));
      localStorage.setItem('vfusion_token', json.data.token);
      showToast(`登录成功！欢迎 ${currentUser.name}`);
      await checkAuth();
    } else {
      showToast(json.error || json.message || '登录失败', 'error');
    }
  } catch (err) {
    showToast('登录异常: ' + err.message, 'error');
  }
}

function handleLogout() {
  localStorage.removeItem('vfusion_user');
  localStorage.removeItem('vfusion_token');
  localStorage.removeItem('vfusion_core_asset_token');
  currentUser = null;
  const overlay = document.getElementById('loginOverlay');
  if (overlay) overlay.style.display = 'flex';
  showToast('已安全退出');
}

function applyRolePermissions() {
  if (!currentUser) return;
  const isAdmin = currentUser.role === 'admin';

  const usersBtn = document.getElementById('tabBtn-users');
  const systemBtn = document.getElementById('tabBtn-system');
  const auditsBtn = document.getElementById('tabBtn-audits');
  const personnelBtn = document.getElementById('tabBtn-personnel');
  const canAudit = isAdmin || currentUser.role === 'auditor';

  if (usersBtn) usersBtn.style.display = isAdmin ? 'inline-flex' : 'none';
  if (systemBtn) systemBtn.style.display = isAdmin ? 'inline-flex' : 'none';
  if (auditsBtn) auditsBtn.style.display = canAudit ? 'inline-flex' : 'none';
  if (personnelBtn) personnelBtn.style.display = canAudit ? 'inline-flex' : 'none';
}

async function loadAlerts() {
  if (!currentUser) return;
  try {
    const res = await apiFetch('/api/alerts');
    const json = await res.json();
    if (json.success) {
      const badge = document.getElementById('alertBadge');
      if (json.unread_count > 0) {
        badge.innerText = json.unread_count;
        badge.style.display = 'flex';
      } else {
        badge.style.display = 'none';
      }

      const container = document.getElementById('alertListContainer');
      if (!container) return;
      if (json.data.length === 0) {
        container.innerHTML = `<div style="text-align:center; padding:1.5rem; color:var(--text-muted);">暂无实时告警通知</div>`;
      } else {
        container.innerHTML = json.data.slice(0, 5).map(item => `
          <div class="alert-item">
            <div style="font-weight:700; color:var(--danger); display:flex; justify-content:space-between;">
              <span>${escapeHtml(item.title)}</span>
              <span style="font-size:0.75rem; color:var(--text-muted); font-weight:normal;">${escapeHtml(new Date(item.timestamp).toLocaleTimeString())}</span>
            </div>
            <div style="margin-top:2px; color:var(--text-sub);">${escapeHtml(item.message)}</div>
          </div>
        `).join('');
      }
    }
  } catch (err) {}
}

function toggleAlertDropdown() {
  document.getElementById('alertDropdown').classList.toggle('open');
}

async function markAlertsRead() {
  try {
    await apiFetch('/api/alerts/read', { method: 'POST' });
    showToast('告警已全部标为已读');
    loadAlerts();
  } catch (err) {
    console.error('标记告警已读失败:', err);
  }
}

function switchTab(tabId) {
  if (!tabId || !document.getElementById(tabId)) tabId = 'tab-events';

  document.querySelectorAll('.nav-item, .tab-btn').forEach(btn => btn.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

  if (typeof event !== 'undefined' && event && event.currentTarget && event.currentTarget.classList) {
    event.currentTarget.classList.add('active');
  }
  const navBtnId = tabId.replace('tab-', 'tabBtn-');
  const navBtn = document.getElementById(navBtnId);
  if (navBtn) navBtn.classList.add('active');

  const targetTab = document.getElementById(tabId);
  if (targetTab) targetTab.classList.add('active');

  // 保存当前 Active Tab 到 Hash 与 LocalStorage，实现刷新页面后保留在当前 Tab
  try {
    if (location.hash !== '#' + tabId) {
      history.replaceState(null, '', '#' + tabId);
    }
    localStorage.setItem('vfusion_core_active_tab', tabId);
  } catch (e) {}

  const pageTitles = {
    'tab-events': '跨网数据汇聚',
    'tab-builder': '表单设计器',
    'tab-ftp': 'FTP 通道配置',
    'tab-webhooks': '第三方消息分发',
    'tab-audits': '系统审计日志',
    'tab-personnel': '涉事人员档案库',
    'tab-users': '用户与权限管理',
    'tab-errors': '死信与纠错中心',
    'tab-system': '系统配置与维护'
  };
  const titleEl = document.getElementById('currentPageTitle');
  if (titleEl && pageTitles[tabId]) {
    titleEl.innerText = pageTitles[tabId];
  }

  if (tabId === 'tab-builder' && typeof loadSchema === 'function') loadSchema();
  if (tabId === 'tab-ftp' && typeof loadCoreFtpConfig === 'function') loadCoreFtpConfig();
  if (tabId === 'tab-webhooks' && typeof loadWebhooks === 'function') loadWebhooks();
  if (tabId === 'tab-audits' && typeof loadFullAuditLogs === 'function') loadFullAuditLogs();
  if (tabId === 'tab-personnel' && typeof loadPersonnelArchive === 'function') loadPersonnelArchive();
  if (tabId === 'tab-users' && typeof loadUsers === 'function') loadUsers();
  if (tabId === 'tab-errors' && typeof loadErrors === 'function') loadErrors();
  if (tabId === 'tab-system' && typeof loadSystemHealth === 'function') loadSystemHealth();
}

window.addEventListener('hashchange', () => {
  const hashTab = location.hash ? location.hash.replace('#', '') : '';
  if (hashTab && document.getElementById(hashTab)) {
    switchTab(hashTab);
  }
});

function openEventDrawer(eventId) {
  const evt = eventsData.find(e => e.event_id === eventId);
  if (!evt) return;

  const p = evt.payload || {};
  document.getElementById('drawerTitle').innerText = `事件详情: ${evt.event_id}`;
  document.getElementById('drawerDownloadZipBtn').onclick = () => downloadEventZip(evt.event_id);

  const aiTagsHtml = (evt.ai_tags || []).length > 0
    ? (evt.ai_tags || []).map(t => `<span class="ai-tag-badge">${escapeHtml(t)}</span>`).join(' ')
    : `<span style="color:var(--text-muted); font-size:0.8rem;">暂无标签</span>`;

  // 图片展示
  const files = evt.files || [];
  const imgsHtml = files.length > 0
    ? files.map(f => `
        <div style="display:flex; flex-direction:column; gap:0.35rem; background:#ffffff; border:1px solid #e2e8f0; border-radius:8px; padding:0.5rem; cursor:pointer;" onclick="openImageLightbox('${escapeJsString(assetUrl(f.url))}', { description:'${escapeJsString(f.description || '')}', timestamp:'${escapeJsString(f.timestamp || '')}', location:'${escapeJsString(f.location || '')}', uploader:'${escapeJsString((f.uploader_name || f.uploader_username || '').split('(')[0].trim())}' })">
          <div style="width:100%; height:110px; background:#0f172a; border-radius:6px; overflow:hidden;">
            <img src="${escapeHtml(assetUrl(f.url))}" style="width:100%; height:100%; object-fit:cover;" onerror="this.style.display='none'">
          </div>
          <div style="font-size:0.7rem; color:#64748b; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeHtml(f.filename || '')}">${escapeHtml(f.filename || '图片')}</div>
        </div>`).join('')
    : `<div style="color:var(--text-muted); font-size:0.8rem; padding:1rem 0;">暂无上传图片</div>`;

  // 基本字段行
  function field(label, value, mono = false) {
    return `<div style="display:flex; gap:0.5rem; padding:0.5rem 0; border-bottom:1px solid #f1f5f9; align-items:flex-start; min-width:0;">
      <span style="font-size:0.775rem; color:#64748b; font-weight:600; white-space:nowrap; min-width:90px; flex-shrink:0;">${label}</span>
      <span style="font-size:0.8rem; color:var(--text-main); ${mono ? 'font-family:monospace; word-break:break-all;' : 'overflow:hidden; text-overflow:ellipsis; white-space:nowrap;'} flex:1; min-width:0;">${value}</span>
    </div>`;
  }

  const sig = evt.signature || '';
  const sigShort = sig.length > 48 ? sig.slice(0, 48) + '...' : sig;

  document.getElementById('drawerBody').innerHTML = `
    <div style="display:flex; flex-direction:column; gap:1rem; min-width:0;">

      <!-- 事件基础信息 -->
      <div style="background:#eff6ff; border:1px solid #bfdbfe; border-radius:10px; padding:0.85rem 1rem;">
        <div style="font-size:0.775rem; font-weight:700; color:#1e40af; margin-bottom:0.6rem; text-transform:uppercase; letter-spacing:0.5px;">事件基础信息</div>
        ${field('事件编号', escapeHtml(evt.event_id), true)}
        ${field('所属任务', escapeHtml(evt.task_name || '-'))}
        ${field('任务编号', escapeHtml(evt.task_code || '-'), true)}
        ${field('提交时间', escapeHtml(new Date(evt.submit_time || evt.timestamp).toLocaleString()))}
        ${field('录入人员', escapeHtml((evt.operator || '-').split('(')[0].trim()))}
        ${field('业务类型', escapeHtml(evt.biz_type || '-'))}
      </div>

      <!-- 现场信息 -->
      <div style="background:#f0fdf4; border:1px solid #bbf7d0; border-radius:10px; padding:0.85rem 1rem;">
        <div style="font-size:0.775rem; font-weight:700; color:#15803d; margin-bottom:0.6rem; text-transform:uppercase; letter-spacing:0.5px;">现场信息</div>
        ${field('发生地点', escapeHtml(p.location || '-'))}
        ${field('交通方式', escapeHtml(p.transportation || '-'))}
        ${p.person_name ? field('涉事姓名', `<strong style="color:var(--primary); cursor:pointer;" onclick="event.stopPropagation(); showPersonDetailModal('${escapeJsString(encodeURIComponent(JSON.stringify(p)))}')">${escapeHtml(p.person_name)}</strong>`) : ''}
        ${p.person_id_card ? field('身份证号', escapeHtml(p.person_id_card), true) : ''}
        ${p.person_domicile ? field('户籍地址', escapeHtml(p.person_domicile)) : ''}
        ${p.description ? field('现场描述', escapeHtml(p.description)) : ''}
      </div>

      <!-- AI 标签 -->
      <div style="background:#fafafa; border:1px solid #e2e8f0; border-radius:10px; padding:0.85rem 1rem;">
        <div style="font-size:0.775rem; font-weight:700; color:#334155; margin-bottom:0.5rem;">要素提取标签</div>
        <div style="display:flex; gap:0.4rem; flex-wrap:wrap;">${aiTagsHtml}</div>
      </div>

      <!-- 上传图片 -->
      ${files.length > 0 ? `
      <div style="background:#fafafa; border:1px solid #e2e8f0; border-radius:10px; padding:0.85rem 1rem;">
        <div style="font-size:0.775rem; font-weight:700; color:#334155; margin-bottom:0.65rem;">上传图片 (${files.length} 张)</div>
        <div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(120px, 1fr)); gap:0.6rem;">${imgsHtml}</div>
      </div>` : ''}

      <!-- 完整性校验 -->
      <div style="background:#fafafa; border:1px solid #e2e8f0; border-radius:10px; padding:0.85rem 1rem;">
        <div style="font-size:0.775rem; font-weight:700; color:#334155; margin-bottom:0.6rem;">数据完整性</div>
        <div style="margin-bottom:0.5rem;">
          <div style="font-size:0.725rem; color:#64748b; margin-bottom:0.2rem;">数字签名 (HMAC-SHA256)</div>
          <div style="font-family:monospace; font-size:0.725rem; color:#0369a1; background:#f0f9ff; padding:0.4rem 0.6rem; border-radius:6px; border:1px solid #bae6fd; word-break:break-all;">${escapeHtml(evt.signature || '未签名')}</div>
        </div>
        <div>
          <div style="font-size:0.725rem; color:#64748b; margin-bottom:0.2rem;">包摘要校验和 (SHA-256 / ZIP Hash)</div>
          <div style="font-family:monospace; font-size:0.725rem; color:#334155; background:#f8fafc; padding:0.4rem 0.6rem; border-radius:6px; border:1px solid #e2e8f0; word-break:break-all;">${escapeHtml(evt.zip_hash || '-')}</div>
        </div>
      </div>

    </div>
  `;
  document.getElementById('drawerOverlay').classList.add('open');
}

function closeDrawer() {
  const overlay = document.getElementById('drawerOverlay');
  if (overlay) overlay.classList.remove('open');
}

// 下载类接口同样需要携带 Token，因此改为取 blob 后再触发浏览器保存
async function downloadWithAuth(url, fallbackName) {
  try {
    const res = await apiFetch(url);
    if (!res.ok) {
      let msg = `下载失败 (HTTP ${res.status})`;
      try {
        const errJson = await res.json();
        if (errJson && errJson.error) msg = errJson.error;
      } catch (e) {}
      showToast(msg, 'error');
      return;
    }
    const disposition = res.headers.get('Content-Disposition') || '';
    const match = disposition.match(/filename=([^;]+)/);
    const filename = match ? decodeURIComponent(match[1].replace(/["']/g, '').trim()) : fallbackName;

    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(objectUrl);
  } catch (err) {
    console.error('下载失败:', err);
  }
}

function downloadEventZip(eventId) {
  showToast(`正在准备 [${eventId}] 存照 Zip 离线包下载...`);
  downloadWithAuth(`/api/events/${encodeURIComponent(eventId)}/download`, `vfusion_${eventId}.zip`);
}

function exportCsvReport() {
  showToast('准备导出 Excel 报表...');
  downloadWithAuth('/api/events/export', 'vfusion_report.csv');
}

async function triggerDiodeSimulation() {
  try {
    const res = await apiFetch('/api/simulate-diode', { method: 'POST' });
    const json = await res.json();
    if (json.success) {
      showToast(json.message);
      if (typeof fetchData === 'function') fetchData();
    } else {
      showToast(json.error || '摆渡执行失败', 'error');
    }
  } catch (err) {
    console.error('摆渡执行失败:', err);
  }
}

window.addEventListener('DOMContentLoaded', async () => {
  await loadPageTemplates();
  checkAuth();
  setInterval(loadAlerts, 5000);
});
