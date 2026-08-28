let errorCurrentPage = 1, errorPageSize = 10;
let cachedErrorData = [];

async function loadErrors() {
  try {
    const res = await fetch('/api/errors');
    const json = await res.json();
    if (json.success) {
      cachedErrorData = json.data || [];
      const statError = document.getElementById('statErrorCount');
      if (statError) statError.innerText = `${cachedErrorData.length} 个`;
      renderErrors();
    }
  } catch (e) {}
}

function renderErrors() {
  const tbody = document.getElementById('errorTableBody');
  if (!tbody) return;
  const totalCount = cachedErrorData.length;
  const totalPages = Math.ceil(totalCount / errorPageSize) || 1;
  if (errorCurrentPage > totalPages) errorCurrentPage = totalPages;
  if (errorCurrentPage < 1) errorCurrentPage = 1;

  if (document.getElementById('errorTotalCount')) document.getElementById('errorTotalCount').innerText = totalCount;
  if (document.getElementById('errorCurrentPageText')) document.getElementById('errorCurrentPageText').innerText = errorCurrentPage;
  if (document.getElementById('errorTotalPagesText')) document.getElementById('errorTotalPagesText').innerText = totalPages;
  if (document.getElementById('errorPrevBtn')) document.getElementById('errorPrevBtn').disabled = errorCurrentPage <= 1;
  if (document.getElementById('errorNextBtn')) document.getElementById('errorNextBtn').disabled = errorCurrentPage >= totalPages;

  if (totalCount === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding:3rem; color:var(--text-muted);">隔离区暂无异常损坏数据包</td></tr>`;
    return;
  }
  const paged = cachedErrorData.slice((errorCurrentPage - 1) * errorPageSize, errorCurrentPage * errorPageSize);
  tbody.innerHTML = paged.map((item, idx) => {
    const globalIdx = (errorCurrentPage - 1) * errorPageSize + idx + 1;
    return `
      <tr>
        <td class="col-idx">${globalIdx}</td>
        <td><code style="color:var(--danger); font-weight:600;">${escapeHtml(item.filename)}</code></td>
        <td>${(item.size / 1024).toFixed(1)} KB</td>
        <td><code>${escapeHtml(new Date(item.mtime).toLocaleString())}</code></td>
        <td><span class="badge-level 高">HMAC校验/文件破坏</span></td>
        <td style="display:flex; gap:0.4rem;">
          <button class="btn btn-primary" style="padding:0.25rem 0.55rem; font-size:0.75rem; white-space:nowrap;" data-action="retryError('${escapeJsString(item.filename)}')">重试解析</button>
          <button class="btn btn-danger" style="padding:0.25rem 0.55rem; font-size:0.75rem; white-space:nowrap;" data-action="deleteError('${escapeJsString(item.filename)}')">删除</button>
        </td>
      </tr>
    `;
  }).join('');
}

function changeErrorPageSize(val) { errorPageSize = parseInt(val); errorCurrentPage = 1; renderErrors(); }
function prevErrorPage() { if (errorCurrentPage > 1) { errorCurrentPage--; renderErrors(); } }
function nextErrorPage() { errorCurrentPage++; renderErrors(); }

async function retryError(filename) {
  try {
    const res = await fetch('/api/errors/retry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename }) });
    const json = await res.json();
    showToast(json.success ? '重试成功已入库！' : '重试失败: ' + json.error, json.success ? 'success' : 'error');
    loadErrors();
  } catch (e) {
    console.error('重试解析失败:', e);
  }
}

async function deleteError(filename) {
  try {
    const res = await fetch(`/api/errors/${encodeURIComponent(filename)}`, { method: 'DELETE' });
    const json = await res.json();
    showToast(json.success ? '删除隔离包成功' : ('删除失败: ' + (json.error || '未知错误')), json.success ? 'success' : 'error');
    loadErrors();
  } catch (e) {
    console.error('删除隔离包失败:', e);
  }
}
