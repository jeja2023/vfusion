let auditCurrentPage = 1, auditPageSize = 10;
let cachedAuditData = [];

function renderAuditLogs() {
  const streamEl = document.getElementById('logStream');
  if (!streamEl) return;
  streamEl.innerHTML = (Array.isArray(auditLogs) ? auditLogs : []).slice(0, 10).map(log => {
    const typeCn = (typeof auditTypeMap !== 'undefined' && auditTypeMap[log.type]) ? auditTypeMap[log.type] : log.type;
    const statusCn = (typeof auditStatusMap !== 'undefined' && auditStatusMap[log.status]) ? auditStatusMap[log.status] : log.status;
    return `
      <div class="log-item ${escapeHtml(log.status)}">
        <div class="log-time">[${escapeHtml(new Date(log.timestamp).toLocaleTimeString())}] [${escapeHtml(typeCn)}] (${escapeHtml(statusCn)})</div>
        <div>${escapeHtml(log.message)}</div>
      </div>
    `;
  }).join('');
}

async function loadFullAuditLogs() {
  try {
    const kwInput = document.getElementById('auditKeyword');
    const statusSelect = document.getElementById('auditStatusFilter');
    const kw = kwInput ? kwInput.value.trim() : '';
    const status = statusSelect ? statusSelect.value : '';
    const fetchFn = typeof apiFetch === 'function' ? apiFetch : fetch;
    const res = await fetchFn(`/api/audit-logs?keyword=${encodeURIComponent(kw)}&status=${encodeURIComponent(status)}`);
    const json = await res.json();
    if (json.success) {
      cachedAuditData = json.data || [];
      renderFullAuditLogs();
    }
  } catch (e) {
    console.error('加载审计日志失败:', e);
  }
}

function renderFullAuditLogs() {
  const tbody = document.getElementById('auditTableBody');
  if (!tbody) return;
  const totalCount = cachedAuditData.length;
  const totalPages = Math.ceil(totalCount / auditPageSize) || 1;
  if (auditCurrentPage > totalPages) auditCurrentPage = totalPages;
  if (auditCurrentPage < 1) auditCurrentPage = 1;

  if (document.getElementById('auditTotalCount')) document.getElementById('auditTotalCount').innerText = totalCount;
  if (document.getElementById('auditCurrentPageText')) document.getElementById('auditCurrentPageText').innerText = auditCurrentPage;
  if (document.getElementById('auditTotalPagesText')) document.getElementById('auditTotalPagesText').innerText = totalPages;
  if (document.getElementById('auditPrevBtn')) document.getElementById('auditPrevBtn').disabled = auditCurrentPage <= 1;
  if (document.getElementById('auditNextBtn')) document.getElementById('auditNextBtn').disabled = auditCurrentPage >= totalPages;

  if (totalCount === 0) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--text-muted);">未查询到审计日志记录</td></tr>`;
    return;
  }
  const paged = cachedAuditData.slice((auditCurrentPage - 1) * auditPageSize, auditCurrentPage * auditPageSize);
  tbody.innerHTML = paged.map((item, idx) => {
    const globalIdx = (auditCurrentPage - 1) * auditPageSize + idx + 1;
    const typeCn = (typeof auditTypeMap !== 'undefined' && auditTypeMap[item.type]) ? auditTypeMap[item.type] : item.type;
    const statusCn = (typeof auditStatusMap !== 'undefined' && auditStatusMap[item.status]) ? auditStatusMap[item.status] : item.status;
    return `
      <tr>
        <td class="col-idx">${globalIdx}</td>
        <td><code>${escapeHtml(new Date(item.timestamp).toLocaleString())}</code></td>
        <td><strong>${escapeHtml(typeCn)}</strong></td>
        <td>${escapeHtml(item.message)}</td>
        <td><span class="badge-level ${item.status === 'ERROR' ? '高' : (item.status === 'WARN' ? '中' : '低')}">${escapeHtml(statusCn)}</span></td>
      </tr>
    `;
  }).join('');
}

function changeAuditPageSize(val) { auditPageSize = parseInt(val); auditCurrentPage = 1; renderFullAuditLogs(); }
function prevAuditPage() { if (auditCurrentPage > 1) { auditCurrentPage--; renderFullAuditLogs(); } }
function nextAuditPage() { auditCurrentPage++; renderFullAuditLogs(); }

async function exportAuditLogsCsv() {
  try {
    showToast('正在导出审计日志 (CSV)...');
    const kwInput = document.getElementById('auditKeyword');
    const statusSelect = document.getElementById('auditStatusFilter');
    const kw = kwInput ? kwInput.value.trim() : '';
    const status = statusSelect ? statusSelect.value : '';
    const fetchFn = typeof apiFetch === 'function' ? apiFetch : fetch;
    const res = await fetchFn(`/api/audit-logs/export?keyword=${encodeURIComponent(kw)}&status=${encodeURIComponent(status)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `vfusion_core_audits_${Date.now()}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(url);
    showToast('审计日志 CSV 导出成功！', 'success');
  } catch (e) {
    console.error('导出审计日志失败:', e);
    showToast('导出审计日志失败: ' + e.message, 'error');
  }
}

Object.assign(window.VFusionActions = window.VFusionActions || {}, {
  renderAuditLogs, loadFullAuditLogs, renderFullAuditLogs, changeAuditPageSize,
  prevAuditPage, nextAuditPage, exportAuditLogsCsv
});
