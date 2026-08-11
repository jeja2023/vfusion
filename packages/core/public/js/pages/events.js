let evtCurrentPage = 1, evtPageSize = 10;

async function fetchData() {
  const appId = 'sys_gate_security';
  try {
    const [evtRes, logRes] = await Promise.all([fetch(`/api/events?app_id=${appId}`), fetch('/api/audit-logs')]);
    const evtJson = await evtRes.json();
    const logJson = await logRes.json();

    if (evtJson.success) {
      eventsData = evtJson.data;
      if (document.getElementById('statEvents')) document.getElementById('statEvents').innerText = eventsData.length;

      const taskSelect = document.getElementById('filterTask');
      if (taskSelect) {
        const currentVal = taskSelect.value;
        const tasksSet = new Set(eventsData.map(e => e.task_name).filter(Boolean));
        let taskOptsHtml = '<option value="">所有任务名称 (全量)</option>';
        tasksSet.forEach(tName => {
          taskOptsHtml += `<option value="${escapeHtml(tName)}" ${currentVal === tName ? 'selected' : ''}>${escapeHtml(tName)}</option>`;
        });
        taskSelect.innerHTML = taskOptsHtml;
      }

      renderEvents();
    }
    if (logJson.success) {
      auditLogs = logJson.data;
      if (typeof renderAuditLogs === 'function') renderAuditLogs();
    }
  } catch (err) { console.error('获取数据失败:', err); }
}

function renderEvents() {
  const tbody = document.getElementById('eventTableBody');
  if (!tbody) return;
  const kw = (document.getElementById('filterKeyword') ? document.getElementById('filterKeyword').value : '').toLowerCase();
  const task = document.getElementById('filterTask') ? document.getElementById('filterTask').value : '';
  const type = document.getElementById('filterType') ? document.getElementById('filterType').value : '';

  const filtered = eventsData.filter(e => {
    const payload = e.payload || {};
    const matchKw = !kw ||
      e.event_id.toLowerCase().includes(kw) ||
      (e.task_name && e.task_name.toLowerCase().includes(kw)) ||
      (e.task_code && e.task_code.toLowerCase().includes(kw)) ||
      (payload.location && payload.location.toLowerCase().includes(kw)) ||
      (payload.person_name && payload.person_name.toLowerCase().includes(kw)) ||
      (payload.person_id_card && payload.person_id_card.toLowerCase().includes(kw)) ||
      (e.operator && e.operator.toLowerCase().includes(kw));
    const matchTask = !task || e.task_name === task;
    const matchType = !type || payload.transportation === type;
    return matchKw && matchTask && matchType;
  });

  const totalCount = filtered.length;
  const totalPages = Math.ceil(totalCount / evtPageSize) || 1;
  if (evtCurrentPage > totalPages) evtCurrentPage = totalPages;
  if (evtCurrentPage < 1) evtCurrentPage = 1;

  if (document.getElementById('evtTotalCount')) document.getElementById('evtTotalCount').innerText = totalCount;
  if (document.getElementById('evtCurrentPageText')) document.getElementById('evtCurrentPageText').innerText = evtCurrentPage;
  if (document.getElementById('evtTotalPagesText')) document.getElementById('evtTotalPagesText').innerText = totalPages;
  if (document.getElementById('evtPrevBtn')) document.getElementById('evtPrevBtn').disabled = evtCurrentPage <= 1;
  if (document.getElementById('evtNextBtn')) document.getElementById('evtNextBtn').disabled = evtCurrentPage >= totalPages;

  if (totalCount === 0) {
    tbody.innerHTML = `<tr><td colspan="11" style="text-align:center; padding:3rem; color:var(--text-muted);">未找到匹配的单据事件数据</td></tr>`;
    return;
  }

  const pagedData = filtered.slice((evtCurrentPage - 1) * evtPageSize, evtCurrentPage * evtPageSize);

  tbody.innerHTML = pagedData.map((item, idx) => {
    const globalIdx = (evtCurrentPage - 1) * evtPageSize + idx + 1;
    const p = item.payload || {};

    const imgsHtml = (item.files || []).map(f =>
      `<img src="${escapeHtml(f.url)}" style="width:34px; height:34px; object-fit:cover; border-radius:6px; border:1px solid var(--border-color); cursor:pointer; transition:transform 0.15s;" onclick="event.stopPropagation(); openImageLightbox('${escapeJsString(f.url)}', '现场存照凭证放大预览 (${escapeJsString(f.filename || '001.jpg')})')" title="点击在弹窗中放大查看">`
    ).join(' ');

    const personStr = p.person_name
      ? `<strong style="color:var(--primary); cursor:pointer; text-decoration:none;" onclick="event.stopPropagation(); showPersonDetailModal('${escapeJsString(encodeURIComponent(JSON.stringify(p)))}')" title="点击弹窗查看涉事人员完整档案">${escapeHtml(p.person_name)}</strong>`
      : '<span style="color:var(--text-muted);">-</span>';

    return `
      <tr style="cursor:pointer;" onclick="openEventDrawer('${escapeJsString(item.event_id)}')">
        <td class="col-idx">${globalIdx}</td>
        <td><strong style="color:var(--primary); font-family:monospace; font-size:0.875rem;">${escapeHtml(item.event_id)}</strong></td>
        <td><strong style="color:var(--text-main); font-weight:700; font-size:0.825rem;">${escapeHtml(item.task_name || '厂区周界例行巡检')}</strong></td>
        <td><code style="font-size:0.75rem; color:#64748b; font-family:monospace;">${escapeHtml(item.task_code || 'TASK_DEFAULT')}</code></td>
        <td><code style="font-size:0.8rem; color:var(--text-sub);">${escapeHtml(new Date(item.submit_time || item.timestamp).toLocaleString())}</code></td>
        <td><span style="font-weight:600; color:var(--text-main);">${escapeHtml(item.operator || '-')}</span></td>
        <td style="min-width:140px; max-width:220px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeHtml(p.location || '-')}"><span style="font-weight:500;">${escapeHtml(p.location || '-')}</span></td>
        <td><span class="ai-tag-badge" style="background:#f0f9ff; color:#0369a1; border-color:#bae6fd; font-weight:600;">${escapeHtml(p.transportation || '-')}</span></td>
        <td>${personStr}</td>
        <td><div style="display:flex; gap:0.3rem;">${imgsHtml || '-'}</div></td>
        <td style="text-align:left; white-space:nowrap;">
          <button class="btn btn-diode" style="padding:0.35rem 0.75rem; font-size:0.775rem;" onclick="event.stopPropagation(); openEventDrawer('${escapeJsString(item.event_id)}')">详情</button>
        </td>
      </tr>
    `;
  }).join('');
}

function changeEvtPageSize(val) { evtPageSize = parseInt(val); evtCurrentPage = 1; renderEvents(); }
function prevEvtPage() { if (evtCurrentPage > 1) { evtCurrentPage--; renderEvents(); } }
function nextEvtPage() { evtCurrentPage++; renderEvents(); }
