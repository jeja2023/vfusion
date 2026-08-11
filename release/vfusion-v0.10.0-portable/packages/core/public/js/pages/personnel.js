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
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:var(--text-muted);">暂无涉事人员跨网同步档案</td></tr>`;
    return;
  }
  const paged = cachedPersonnelData.slice((personnelCurrentPage - 1) * personnelPageSize, personnelCurrentPage * personnelPageSize);
  tbody.innerHTML = paged.map((item, idx) => {
    const globalIdx = (personnelCurrentPage - 1) * personnelPageSize + idx + 1;
    return `
      <tr>
        <td class="col-idx">${globalIdx}</td>
        <td><strong>${item.name || '未知'}</strong></td>
        <td><code>${item.id_card || '-'}</code></td>
        <td>${item.domicile || '-'}</td>
        <td><code>${item.last_seen ? new Date(item.last_seen).toLocaleString() : '-'}</code></td>
        <td><code>${item.last_event_id || '-'}</code></td>
      </tr>
    `;
  }).join('');
}

function changePersonnelPageSize(val) { personnelPageSize = parseInt(val); personnelCurrentPage = 1; renderPersonnelArchive(); }
function prevPersonnelPage() { if (personnelCurrentPage > 1) { personnelCurrentPage--; renderPersonnelArchive(); } }
function nextPersonnelPage() { personnelCurrentPage++; renderPersonnelArchive(); }
