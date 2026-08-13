let historyCurrentPage = 1, historyPageSize = 10;
let cachedHistoryData = [];

async function loadPublishedHistory() {
  try {
    const fetchFn = typeof apiFetch === 'function' ? apiFetch : fetch;
    const res = await fetchFn('/api/published-history');
    const json = await res.json();
    if (json.success) {
      cachedHistoryData = json.data || [];
      
      const taskSelect = document.getElementById('historyTaskFilter');
      if (taskSelect) {
        const currentVal = taskSelect.value;
        const tasksSet = new Set(cachedHistoryData.map(e => e.task_name).filter(Boolean));
        let taskOptsHtml = '<option value="">所有任务名称 (全量)</option>';
        tasksSet.forEach(tName => {
          taskOptsHtml += `<option value="${escapeHtml(tName)}" ${currentVal === tName ? 'selected' : ''}>${escapeHtml(tName)}</option>`;
        });
        taskSelect.innerHTML = taskOptsHtml;
      }

      renderPublishedHistory();
    }
  } catch (e) {
    console.error('加载历史已发布数据失败:', e);
  }
}

function renderPublishedHistory() {
  const tbody = document.getElementById('historyTableBody');
  if (!tbody) return;
  const kw = (document.getElementById('historyKeyword') ? document.getElementById('historyKeyword').value : '').toLowerCase();
  const task = document.getElementById('historyTaskFilter') ? document.getElementById('historyTaskFilter').value : '';

  const filtered = cachedHistoryData.filter(e => {
    if (!e) return false;
    const payload = e.payload || {};
    const eventIdStr = String(e.event_id || '').toLowerCase();
    const taskNameStr = String(e.task_name || '').toLowerCase();
    const taskCodeStr = String(e.task_code || '').toLowerCase();
    const locationStr = String(payload.location || '').toLowerCase();
    const personNameStr = String(payload.person_name || '').toLowerCase();
    const personIdCardStr = String(payload.person_id_card || '').toLowerCase();
    const operatorStr = String(e.operator || '').toLowerCase();

    const matchKw = !kw || 
      eventIdStr.includes(kw) || 
      taskNameStr.includes(kw) ||
      taskCodeStr.includes(kw) ||
      locationStr.includes(kw) || 
      personNameStr.includes(kw) || 
      personIdCardStr.includes(kw) || 
      operatorStr.includes(kw);
    const matchTask = !task || e.task_name === task;
    return matchKw && matchTask;
  });

  const totalCount = filtered.length;
  const totalPages = Math.ceil(totalCount / historyPageSize) || 1;
  if (historyCurrentPage > totalPages) historyCurrentPage = totalPages;
  if (historyCurrentPage < 1) historyCurrentPage = 1;

  if (document.getElementById('historyTotalCount')) document.getElementById('historyTotalCount').innerText = totalCount;
  if (document.getElementById('historyCurrentPageText')) document.getElementById('historyCurrentPageText').innerText = historyCurrentPage;
  if (document.getElementById('historyTotalPagesText')) document.getElementById('historyTotalPagesText').innerText = totalPages;
  if (document.getElementById('historyPrevBtn')) document.getElementById('historyPrevBtn').disabled = historyCurrentPage <= 1;
  if (document.getElementById('historyNextBtn')) document.getElementById('historyNextBtn').disabled = historyCurrentPage >= totalPages;

  if (totalCount === 0) {
    tbody.innerHTML = `<tr><td colspan="11" style="text-align:center; padding:3rem; color:var(--text-muted);">暂无匹配的已发布单据历史记录</td></tr>`;
    return;
  }

  const paged = filtered.slice((historyCurrentPage - 1) * historyPageSize, historyCurrentPage * historyPageSize);

  tbody.innerHTML = paged.map((item, idx) => {
    const globalIdx = (historyCurrentPage - 1) * historyPageSize + idx + 1;
    const p = item.payload || {};

    const imgsHtml = (item.files || []).map(f =>
      `<img src="${escapeHtml(f.url)}" style="width:28px; height:28px; object-fit:cover; border-radius:4px; border:1px solid var(--border-color); cursor:pointer; transition:transform 0.15s;" onclick="event.stopPropagation(); openImageLightbox('${escapeJsString(f.url)}', '现场照片放大预览 (${escapeJsString(f.filename || '001.jpg')})')" title="点击在弹窗中放大查看">`
    ).join(' ');

    const personStr = p.person_name
      ? `<strong style="color:var(--primary); cursor:pointer; text-decoration:none; font-size:0.775rem;" onclick="event.stopPropagation(); showPersonDetailModal('${escapeJsString(encodeURIComponent(JSON.stringify(p)))}')" title="点击弹窗查看涉事人员完整档案">${escapeHtml(p.person_name)}</strong>`
      : '<span style="color:var(--text-muted);">-</span>';

    const realOperatorName = formatUserForTable(item.operator_name || item.operator);

    return `
      <tr>
        <td class="col-idx" style="text-align:center; white-space:nowrap;">${globalIdx}</td>
        <td style="white-space:nowrap;"><strong style="color:var(--primary); font-family:monospace; font-size:0.8rem;">${escapeHtml(item.event_id)}</strong></td>
        <td style="white-space:nowrap;"><strong style="color:var(--text-main); font-weight:700; font-size:0.8rem;">${escapeHtml(item.task_name || '厂区周界例行巡检')}</strong></td>
        <td style="white-space:nowrap;"><code style="font-size:0.75rem; color:#64748b; font-family:monospace;">${escapeHtml(item.task_code || 'TASK_DEFAULT')}</code></td>
        <td style="white-space:nowrap;"><code style="font-size:0.775rem; color:var(--text-sub);">${escapeHtml(new Date(item.timestamp).toLocaleString())}</code></td>
        <td style="white-space:nowrap;"><span style="font-weight:600; color:var(--text-main); font-size:0.8rem;">${escapeHtml(realOperatorName)}</span></td>
        <td style="max-width:150px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeHtml(p.location || '-')}"><span style="font-weight:500; font-size:0.775rem;">${escapeHtml(p.location || '-')}</span></td>
        <td style="text-align:center; white-space:nowrap;"><span class="ai-tag-badge" style="background:#f0f9ff; color:#0369a1; border-color:#bae6fd; font-weight:600; padding:0.15rem 0.4rem; font-size:0.725rem;">${escapeHtml(p.traffic_mode || p.transportation || '-')}</span></td>
        <td style="white-space:nowrap;">${personStr}</td>
        <td style="text-align:center; white-space:nowrap;"><div style="display:flex; gap:0.2rem; justify-content:center;">${imgsHtml || '-'}</div></td>
        <td style="text-align:center; white-space:nowrap;"><span style="color:var(--success); font-weight:600; font-size:0.725rem; background:#f0fdf4; padding:0.15rem 0.4rem; border-radius:4px; border:1px solid #bbf7d0;">已打包存入网闸</span></td>
      </tr>
    `;
  }).join('');
}

function changeHistoryPageSize(val) { historyPageSize = parseInt(val); historyCurrentPage = 1; renderPublishedHistory(); }
function prevHistoryPage() { if (historyCurrentPage > 1) { historyCurrentPage--; renderPublishedHistory(); } }
function nextHistoryPage() { historyCurrentPage++; renderPublishedHistory(); }
