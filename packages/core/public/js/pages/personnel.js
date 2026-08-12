let personnelCurrentPage = 1, personnelPageSize = 10;
let cachedPersonnelData = [];

async function loadPersonnelArchive() {
  try {
    const res = await fetch('/api/personnel');
    const json = await res.json();
    if (json.success) {
      cachedPersonnelData = json.data || [];
      renderPersonnelArchive();
    }
  } catch (e) {}
}

function renderPersonnelArchive() {
  const tbody = document.getElementById('personnelTableBody');
  if (!tbody) return;
  const totalCount = cachedPersonnelData.length;
  const totalPages = Math.ceil(totalCount / personnelPageSize) || 1;
  if (personnelCurrentPage > totalPages) personnelCurrentPage = totalPages;
  if (personnelCurrentPage < 1) personnelCurrentPage = 1;

  if (document.getElementById('personnelTotalCount')) document.getElementById('personnelTotalCount').innerText = totalCount;
  if (document.getElementById('personnelCurrentPageText')) document.getElementById('personnelCurrentPageText').innerText = personnelCurrentPage;
  if (document.getElementById('personnelTotalPagesText')) document.getElementById('personnelTotalPagesText').innerText = totalPages;
  if (document.getElementById('personnelPrevBtn')) document.getElementById('personnelPrevBtn').disabled = personnelCurrentPage <= 1;
  if (document.getElementById('personnelNextBtn')) document.getElementById('personnelNextBtn').disabled = personnelCurrentPage >= totalPages;

  if (totalCount === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; color:var(--text-muted);">暂无涉事人员跨网同步档案</td></tr>`;
    return;
  }
  const paged = cachedPersonnelData.slice((personnelCurrentPage - 1) * personnelPageSize, personnelCurrentPage * personnelPageSize);
  tbody.innerHTML = paged.map((item, idx) => {
    const globalIdx = (personnelCurrentPage - 1) * personnelPageSize + idx + 1;
    return `
      <tr>
        <td class="col-idx">${globalIdx}</td>
        <td><strong>${escapeHtml(item.name || '未知')}</strong></td>
        <td><code>${escapeHtml(item.id_card || '-')}</code></td>
        <td>${escapeHtml(item.domicile || '-')}</td>
        <td><code>${escapeHtml(item.last_seen ? new Date(item.last_seen).toLocaleString() : '-')}</code></td>
        <td><code>${escapeHtml(item.last_event_id || '-')}</code></td>
        <td>
          <button class="btn" style="padding:0.2rem 0.45rem; font-size:0.75rem; background:#eff6ff; border:1px solid #bfdbfe; color:#1d4ed8;" onclick="editPersonnel('${escapeJsString(item.id)}', '${escapeJsString(item.name)}', '${escapeJsString(item.id_card)}', '${escapeJsString(item.domicile)}')">✏️ 编辑</button>
          <button class="btn" style="padding:0.2rem 0.45rem; font-size:0.75rem; background:#fef2f2; border:1px solid #fecaca; color:#dc2626;" onclick="deletePersonnel('${escapeJsString(item.id)}')">🗑️ 删除</button>
        </td>
      </tr>
    `;
  }).join('');
}

async function editPersonnel(id, curName, curIdCard, curDomicile) {
  const name = prompt('请输入人员姓名:', curName);
  if (name === null) return;
  const id_card = prompt('请输入身份证号:', curIdCard);
  if (id_card === null) return;
  const domicile = prompt('请输入户籍地址:', curDomicile);
  if (domicile === null) return;

  try {
    const res = await fetch(`/api/personnel/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim(), id_card: id_card.trim(), domicile: domicile.trim() })
    });
    const json = await res.json();
    if (json.success) {
      alert(json.message);
      loadPersonnelArchive();
    } else {
      alert('编辑失败: ' + json.error);
    }
  } catch (e) {
    alert('编辑请求错误: ' + e.message);
  }
}

async function deletePersonnel(id) {
  if (!confirm('确定要删除该涉事人员档案吗？')) return;

  try {
    const res = await fetch(`/api/personnel/${encodeURIComponent(id)}`, {
      method: 'DELETE'
    });
    const json = await res.json();
    if (json.success) {
      alert(json.message);
      loadPersonnelArchive();
    } else {
      alert('删除失败: ' + json.error);
    }
  } catch (e) {
    alert('删除请求错误: ' + e.message);
  }
}

function changePersonnelPageSize(val) { personnelPageSize = parseInt(val); personnelCurrentPage = 1; renderPersonnelArchive(); }
function prevPersonnelPage() { if (personnelCurrentPage > 1) { personnelCurrentPage--; renderPersonnelArchive(); } }
function nextPersonnelPage() { personnelCurrentPage++; renderPersonnelArchive(); }
