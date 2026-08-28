let auditCurrentPage = 1, auditPageSize = 10;
let cachedAuditData = [];

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
      renderAuditLogs();
    }
  } catch (e) {
    console.error('加载审计日志失败:', e);
  }
}

function renderAuditLogs() {
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
    const typeCn = auditTypeMap[item.type] || item.type;
    const statusCn = auditStatusMap[item.status] || item.status;
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

function changeAuditPageSize(val) { auditPageSize = parseInt(val); auditCurrentPage = 1; renderAuditLogs(); }
function prevAuditPage() { if (auditCurrentPage > 1) { auditCurrentPage--; renderAuditLogs(); } }
function nextAuditPage() { auditCurrentPage++; renderAuditLogs(); }

function exportAuditLogsCsv() {
  showToast('正在导出视频网审计日志 (CSV)...');
  window.location.href = '/api/audit-logs/export';
}

Object.assign(window.VFusionActions = window.VFusionActions || {}, {
  loadFullAuditLogs, renderAuditLogs, changeAuditPageSize, prevAuditPage, nextAuditPage, exportAuditLogsCsv
});
