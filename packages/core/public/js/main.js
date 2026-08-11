let currentUser = null;
let eventsData = [];
let auditLogs = [];
let currentSchema = { fields: [] };

const auditTypeMap = {
  'AUTH_SUCCESS': '用户登录',
  'AUTH_FAIL': '登录失败',
  'USER_ADD': '新增用户',
  'USER_PWD_RESET': '重置密码',
  'USER_DEL': '删除用户',
  'INGEST': '单据入库',
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
  const pages = ['events', 'analytics', 'builder', 'webhooks', 'audits', 'personnel', 'users', 'errors', 'system'];
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

function showToast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <svg class="icon-svg" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
    <span>${message}</span>
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

function openImageLightbox(url, title = '现场照片大图凭证') {
  const overlay = document.getElementById('imageLightboxOverlay');
  const img = document.getElementById('lightboxImg');
  const caption = document.getElementById('lightboxCaption');
  img.src = url;
  caption.innerText = title;
  overlay.style.display = 'flex';
}

function closeImageLightbox() {
  document.getElementById('imageLightboxOverlay').style.display = 'none';
}

function showPersonDetailModal(encodedJson) {
  try {
    const p = JSON.parse(decodeURIComponent(encodedJson));
    document.getElementById('modalPersonName').innerText = p.person_name || '未知';
    document.getElementById('modalPersonIdCard').innerText = p.person_id_card || '未填';
    document.getElementById('modalPersonDomicile').innerText = p.person_domicile || '未填';
    document.getElementById('personDetailModal').style.display = 'flex';
  } catch (e) { console.error('解析涉事人员信息失败:', e); }
}

function closePersonDetailModal() {
  document.getElementById('personDetailModal').style.display = 'none';
}

async function checkAuth() {
  const storedUser = localStorage.getItem('vfusion_user');
  if (storedUser) {
    currentUser = JSON.parse(storedUser);
    document.getElementById('loginOverlay').style.display = 'none';
    document.getElementById('userInfoTag').innerText = `${currentUser.name} (${currentUser.username})`;
    applyRolePermissions();
    if (typeof fetchData === 'function') fetchData();
    loadAlerts();
  } else {
    document.getElementById('loginOverlay').style.display = 'flex';
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
      localStorage.setItem('vfusion_user', JSON.stringify(currentUser));
      localStorage.setItem('vfusion_token', json.data.token);
      showToast(`登录成功！欢迎 ${currentUser.name}`);
      checkAuth();
    } else {
      showToast(json.error, 'error');
    }
  } catch (err) {
    showToast('登录异常: ' + err.message, 'error');
  }
}

function handleLogout() {
  localStorage.removeItem('vfusion_user');
  localStorage.removeItem('vfusion_token');
  currentUser = null;
  document.getElementById('loginOverlay').style.display = 'flex';
  showToast('已安全退出');
}

function applyRolePermissions() {
  if (!currentUser) return;
  const role = currentUser.role;

  if (role === 'operator') {
    document.getElementById('tabBtn-users').style.display = 'none';
    document.getElementById('tabBtn-system').style.display = 'none';
  } else {
    document.getElementById('tabBtn-users').style.display = 'inline-flex';
    document.getElementById('tabBtn-system').style.display = 'inline-flex';
  }
}

async function loadAlerts() {
  try {
    const res = await fetch('/api/alerts');
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
              <span>${item.title}</span>
              <span style="font-size:0.75rem; color:var(--text-muted); font-weight:normal;">${new Date(item.timestamp).toLocaleTimeString()}</span>
            </div>
            <div style="margin-top:2px; color:var(--text-sub);">${item.message}</div>
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
  await fetch('/api/alerts/read', { method: 'POST' });
  showToast('告警已全部标为已读');
  loadAlerts();
}

function toggleFullscreenDashboard() {
  document.body.classList.toggle('fullscreen-mode');
  showToast(document.body.classList.contains('fullscreen-mode') ? '已进入安防指挥大屏模式' : '已退出大屏模式');
}

function switchTab(tabId) {
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  if (event && event.currentTarget) event.currentTarget.classList.add('active');
  const targetTab = document.getElementById(tabId);
  if (targetTab) targetTab.classList.add('active');

  if (tabId === 'tab-analytics' && typeof loadAnalytics === 'function') loadAnalytics();
  if (tabId === 'tab-builder' && typeof loadSchema === 'function') loadSchema();
  if (tabId === 'tab-webhooks' && typeof loadWebhooks === 'function') loadWebhooks();
  if (tabId === 'tab-audits' && typeof loadFullAuditLogs === 'function') loadFullAuditLogs();
  if (tabId === 'tab-personnel' && typeof loadPersonnelArchive === 'function') loadPersonnelArchive();
  if (tabId === 'tab-users' && typeof loadUsers === 'function') loadUsers();
  if (tabId === 'tab-errors' && typeof loadErrors === 'function') loadErrors();
  if (tabId === 'tab-system' && typeof loadSystemHealth === 'function') loadSystemHealth();
}

function openEventDrawer(eventId) {
  const evt = eventsData.find(e => e.event_id === eventId);
  if (!evt) return;

  document.getElementById('drawerTitle').innerText = `单据详情分析与存照: ${evt.event_id}`;
  document.getElementById('drawerDownloadZipBtn').onclick = () => downloadEventZip(evt.event_id);

  const aiTagsHtml = (evt.ai_tags || []).map(t => `<span class="ai-tag-badge">${t}</span>`).join(' ');

  document.getElementById('drawerBody').innerHTML = `
    <div style="margin-bottom:1.5rem;">
      <h4 style="font-size:0.875rem; color:var(--text-muted); margin-bottom:0.5rem;">AI 智能提取管道分析特征</h4>
      <div style="display:flex; gap:0.5rem; flex-wrap:wrap;">${aiTagsHtml}</div>
    </div>
    <div style="margin-bottom:1.5rem;">
      <h4 style="font-size:0.875rem; color:var(--text-muted); margin-bottom:0.5rem;">数字签名 (SHA-256)</h4>
      <div style="font-family:monospace; font-size:0.8rem; background:#f8fafc; padding:0.6rem; border-radius:6px; border:1px solid var(--border-color); word-break:break-all;">${evt.signature || '未签名'}</div>
    </div>
    <div style="margin-bottom:1.5rem;">
      <h4 style="font-size:0.875rem; color:var(--text-muted); margin-bottom:0.5rem;">数据包摘要校验和 (MD5)</h4>
      <div style="font-family:monospace; font-size:0.8rem; background:#f8fafc; padding:0.6rem; border-radius:6px; border:1px solid var(--border-color);">${evt.zip_hash}</div>
    </div>
    <div>
      <h4 style="font-size:0.875rem; color:var(--text-muted); margin-bottom:0.5rem;">结构化元数据</h4>
      <pre style="font-family:monospace; font-size:0.8rem; background:#0f172a; color:#38bdf8; padding:1rem; border-radius:8px; overflow-x:auto;">${JSON.stringify(evt, null, 2)}</pre>
    </div>
  `;
  document.getElementById('drawerOverlay').classList.add('open');
}

function closeDrawer() {
  const overlay = document.getElementById('drawerOverlay');
  if (overlay) overlay.classList.remove('open');
}

function downloadEventZip(eventId) {
  showToast(`正在准备 [${eventId}] 存照 Zip 离线包下载...`);
  window.location.href = `/api/events/${eventId}/download`;
}

function exportCsvReport() {
  showToast('准备导出 Excel 报表...');
  window.location.href = '/api/events/export';
}

async function triggerDiodeSimulation() {
  const res = await fetch('/api/simulate-diode', { method: 'POST' });
  const json = await res.json();
  if (json.success) {
    showToast(json.message);
    if (typeof fetchData === 'function') fetchData();
  }
}

window.addEventListener('DOMContentLoaded', async () => {
  await loadPageTemplates();
  checkAuth();
  setInterval(loadAlerts, 5000);
});
