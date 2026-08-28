let evtCurrentPage = 1, evtPageSize = 10;
let taskCurrentPage = 1, taskPageSize = 10;
let coreTasksData = [];
let coreViewMode = 'event';
let currentCorePhotos = [];

function viewCorePhotoLightbox(photoId) {
  const p = currentCorePhotos.find(i => i.id === photoId);
  if (!p) return;
  const formattedTime = p.timestamp ? new Date(p.timestamp).toLocaleString() : '未知时间';
  openImageLightbox(p.url, {
    description: p.description || '',
    timestamp: formattedTime,
    location: p.location || '',
    uploader: p.uploader_name || p.uploader_username || ''
  });
}

async function fetchData() {
  const appId = 'sys_gate_security';
  try {
    const [evtRes, taskRes, logRes] = await Promise.all([
      fetch('/api/events'),
      fetch('/api/tasks'),
      fetch('/api/audit-logs')
    ]);
    const evtJson = await evtRes.json();
    const taskJson = await taskRes.json();
    const logJson = await logRes.json();

    if (evtJson.success) {
      eventsData = evtJson.data || [];
    }

    if (taskJson.success) {
      coreTasksData = taskJson.data || [];
    }

    // 更新统计数据卡片
    const totalTasks = coreTasksData.length;
    let totalPhotos = 0;
    eventsData.forEach(e => {
      totalPhotos += Array.isArray(e.files) ? e.files.length : 0;
    });

    if (document.getElementById('statTasksTotal')) document.getElementById('statTasksTotal').innerText = totalTasks;
    if (document.getElementById('statTaskPhotosTotal')) document.getElementById('statTaskPhotosTotal').innerText = totalPhotos;

    // 填充任务下拉选项过滤
    const taskSelect = document.getElementById('filterTask');
    if (taskSelect) {
      const currentVal = taskSelect.value;
      const tasksMap = new Map();
      coreTasksData.forEach(t => {
        if (t.task_name) tasksMap.set(t.task_name, t.task_name);
      });
      let taskOptsHtml = '<option value="">所有任务名称 (全量)</option>';
      tasksMap.forEach((tVal, tName) => {
        taskOptsHtml += `<option value="${escapeHtml(tName)}" ${currentVal === tName ? 'selected' : ''}>${escapeHtml(tName)}</option>`;
      });
      taskSelect.innerHTML = taskOptsHtml;
    }

    renderCoreDashboard();

    if (logJson.success) {
      auditLogs = logJson.data || [];
      if (typeof renderAuditLogs === 'function') renderAuditLogs();
    }
  } catch (err) { console.error('获取内网中台数据失败:', err); }
}

function switchCoreView(mode) {
  coreViewMode = mode;
  const taskBtn = document.getElementById('viewBtn-task');
  const evtBtn = document.getElementById('viewBtn-event');
  const taskView = document.getElementById('taskMatrixView');
  const evtView = document.getElementById('eventTableView');

  if (mode === 'task') {
    if (taskBtn) { taskBtn.style.background = '#ffffff'; taskBtn.style.color = 'var(--primary)'; taskBtn.style.fontWeight = '700'; taskBtn.style.boxShadow = '0 1px 2px rgba(0,0,0,0.1)'; }
    if (evtBtn) { evtBtn.style.background = 'transparent'; evtBtn.style.color = '#64748b'; evtBtn.style.fontWeight = '500'; evtBtn.style.boxShadow = 'none'; }
    if (taskView) taskView.style.display = 'block';
    if (evtView) evtView.style.display = 'none';
  } else {
    if (evtBtn) { evtBtn.style.background = '#ffffff'; evtBtn.style.color = 'var(--primary)'; evtBtn.style.fontWeight = '700'; evtBtn.style.boxShadow = '0 1px 2px rgba(0,0,0,0.1)'; }
    if (taskBtn) { taskBtn.style.background = 'transparent'; taskBtn.style.color = '#64748b'; taskBtn.style.fontWeight = '500'; taskBtn.style.boxShadow = 'none'; }
    if (taskView) taskView.style.display = 'none';
    if (evtView) evtView.style.display = 'block';
  }

  renderCoreDashboard();
}

function renderCoreDashboard() {
  if (coreViewMode === 'task') {
    renderTaskMatrix();
  } else {
    renderEvents();
  }
}

function renderTaskMatrix() {
  const tbody = document.getElementById('taskTableBody');
  if (!tbody) return;

  const kw = (document.getElementById('filterKeyword') ? document.getElementById('filterKeyword').value : '').toLowerCase();
  const taskFilter = document.getElementById('filterTask') ? document.getElementById('filterTask').value : '';

  const filteredTasks = coreTasksData.filter(t => {
    if (!t) return false;
    const matchKw = !kw ||
      (t.task_name || '').toLowerCase().includes(kw) ||
      (t.task_code || '').toLowerCase().includes(kw) ||
      (t.description || '').toLowerCase().includes(kw) ||
      (t.creator_name || '').toLowerCase().includes(kw);
    const matchTask = !taskFilter || t.task_name === taskFilter || t.task_code === taskFilter;
    return matchKw && matchTask;
  });

  const totalCount = filteredTasks.length;
  const totalPages = Math.ceil(totalCount / taskPageSize) || 1;
  if (taskCurrentPage > totalPages) taskCurrentPage = totalPages;
  if (taskCurrentPage < 1) taskCurrentPage = 1;

  if (document.getElementById('taskTotalCount')) document.getElementById('taskTotalCount').innerText = totalCount;
  if (document.getElementById('taskCurrentPageText')) document.getElementById('taskCurrentPageText').innerText = taskCurrentPage;
  if (document.getElementById('taskTotalPagesText')) document.getElementById('taskTotalPagesText').innerText = totalPages;
  if (document.getElementById('taskPrevBtn')) document.getElementById('taskPrevBtn').disabled = taskCurrentPage <= 1;
  if (document.getElementById('taskNextBtn')) document.getElementById('taskNextBtn').disabled = taskCurrentPage >= totalPages;

  if (totalCount === 0) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center; padding:3rem; color:var(--text-muted);">暂无匹配的已摆渡汇聚任务数据</td></tr>`;
    return;
  }

  const paged = filteredTasks.slice((taskCurrentPage - 1) * taskPageSize, taskCurrentPage * taskPageSize);

  tbody.innerHTML = paged.map((t, idx) => {
    const globalIdx = (taskCurrentPage - 1) * taskPageSize + idx + 1;
    const isActive = t.status === 'ACTIVE';
    const statusBadge = isActive
      ? `<span style="background:#e0f2fe; color:#0284c7; font-size:0.75rem; font-weight:700; padding:0.2rem 0.5rem; border-radius:4px; border:1px solid #bae6fd;">进行中</span>`
      : `<span style="background:#f1f5f9; color:#64748b; font-size:0.75rem; font-weight:600; padding:0.2rem 0.5rem; border-radius:4px; border:1px solid #cbd5e1;">已完成</span>`;

    const latestTime = t.latest_timestamp ? new Date(t.latest_timestamp).toLocaleString() : '暂无数据';
    const rawContributors = (t.contributors && t.contributors.length > 0) ? t.contributors : [t.creator_name || t.creator_username || '视频网操作员'];
    const contributors = rawContributors.map(c => formatUserForTable(c)).join(', ');

    return `
      <tr style="cursor:pointer;" data-action="openTaskDetailDrawer('${escapeJsString(t.task_code)}')">
        <td class="col-idx" style="font-weight:600; color:#64748b;">${globalIdx}</td>
        <td>
          <strong style="color:var(--text-main); font-size:0.875rem;">${escapeHtml(t.task_name)}</strong>
        </td>
        <td>
          <span style="font-family:monospace; font-size:0.8rem; color:var(--primary); font-weight:600;">${escapeHtml(t.task_code)}</span>
        </td>
        <td>${statusBadge}</td>
        <td style="text-align:center;">
          <span style="font-weight:700; color:#1d4ed8; font-size:0.875rem;">${t.photo_count || 0}</span>
        </td>
        <td style="text-align:center;">
          <span style="font-weight:700; color:#15803d; font-size:0.875rem;">${t.event_count || 0}</span>
        </td>
        <td style="font-size:0.8rem; color:#334155;">${escapeHtml(contributors)}</td>
        <td style="font-size:0.775rem; color:#64748b;">${escapeHtml(latestTime)}</td>
        <td style="text-align:center; white-space:nowrap;">
          <div style="display:flex; gap:0.35rem; justify-content:center; align-items:center;">
            <button class="btn" style="background:#fef3c7; border:1px solid #fde68a; color:#b45309; font-weight:600; padding:0.2rem 0.55rem; font-size:0.75rem; border-radius:4px; min-width:44px; white-space:nowrap;" data-action="event.stopPropagation(); openCoreTaskTrackMap('${escapeJsString(t.task_code)}')">轨迹</button>
            <button class="btn btn-primary" style="padding:0.2rem 0.55rem; font-size:0.75rem; font-weight:600; border-radius:4px; min-width:44px; white-space:nowrap;" data-action="event.stopPropagation(); openTaskDetailDrawer('${escapeJsString(t.task_code)}')">详情</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function changeTaskPageSize(val) { taskPageSize = parseInt(val); taskCurrentPage = 1; renderTaskMatrix(); }
function prevTaskPage() { if (taskCurrentPage > 1) { taskCurrentPage--; renderTaskMatrix(); } }
function nextTaskPage() { taskCurrentPage++; renderTaskMatrix(); }

async function openTaskDetailDrawer(taskCode) {
  try {
    const [taskRes, imgRes] = await Promise.all([
      fetch(`/api/tasks/${encodeURIComponent(taskCode)}`),
      fetch(`/api/tasks/${encodeURIComponent(taskCode)}/images?order=ASC`)
    ]);
    const json = await taskRes.json();
    const imgJson = await imgRes.json();

    if (json.success) {
      const t = json.data;
      document.getElementById('drawerTitle').innerText = `任务详情: ${t.task_name}`;
      // 隐藏下载按钮（任务无 ZIP），但保留占位
      const dlBtn = document.getElementById('drawerDownloadZipBtn');
      if (dlBtn) dlBtn.style.display = 'none';

      const drawerBody = document.getElementById('drawerBody');
      const events = t.events || [];
      const photos = imgJson.success ? imgJson.data : [];
      currentCorePhotos = photos;

      // 基本字段行（与事件详情保持一致）
      function field(label, value, mono = false) {
        return `<div style="display:flex; gap:0.5rem; padding:0.5rem 0; border-bottom:1px solid #f1f5f9; align-items:flex-start; min-width:0;">
          <span style="font-size:0.775rem; color:#64748b; font-weight:600; white-space:nowrap; min-width:90px; flex-shrink:0;">${label}</span>
          <span style="font-size:0.8rem; color:var(--text-main); ${mono ? 'font-family:monospace; word-break:break-all;' : 'overflow:hidden; text-overflow:ellipsis; white-space:nowrap;'} flex:1; min-width:0;">${value}</span>
        </div>`;
      }

      // 图片网格
      const photoCards = photos.map((p, idx) => {
        const canEdit = p.can_edit;
        const canDelete = p.can_delete;
        const formattedTime = p.timestamp ? new Date(p.timestamp).toLocaleString() : '未知时间';
        const editBtn = canEdit
          ? `<button class="btn" style="background:#eff6ff; border:1px solid #bfdbfe; color:#1d4ed8; font-size:0.7rem; padding:0.2rem 0.45rem;" data-action="coreEditImage('${escapeJsString(p.id)}', '${escapeJsString(taskCode)}')">编辑</button>`
          : '';
        const deleteBtn = canDelete
          ? `<button class="btn" style="background:#fef2f2; border:1px solid #fecaca; color:#dc2626; font-size:0.7rem; padding:0.2rem 0.45rem;" data-action="coreDeleteImage('${escapeJsString(p.id)}', '${escapeJsString(taskCode)}')">删除</button>`
          : '';
        return `
          <div style="background:#ffffff; border:1px solid #e2e8f0; border-radius:8px; padding:0.5rem; display:flex; flex-direction:column; gap:0.35rem; box-shadow:0 1px 3px rgba(0,0,0,0.04);">
            <div style="width:100%; height:110px; background:#0f172a; border-radius:6px; overflow:hidden; cursor:pointer;" data-action="viewCorePhotoLightbox('${escapeJsString(p.id)}')">
              <img src="${escapeHtml(assetUrl(p.url))}" style="width:100%; height:100%; object-fit:cover;" data-action-error="this.style.display='none'">
            </div>
            <div style="font-size:0.7rem; color:#64748b; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeHtml(formattedTime)}">
              <span style="background:#0284c7; color:#fff; padding:0.05rem 0.3rem; border-radius:3px; font-weight:700; margin-right:0.25rem;">#${idx + 1}</span>${formattedTime}
            </div>
            ${p.uploader_name || p.uploader_username ? `<div style="font-size:0.7rem; color:#64748b; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">上传: ${escapeHtml((p.uploader_name || p.uploader_username || '').split('(')[0].trim())}</div>` : ''}
            <div style="display:flex; gap:0.3rem; justify-content:flex-end; border-top:1px solid #f1f5f9; padding-top:0.35rem; margin-top:0.1rem; flex-wrap:wrap;">
              <button class="btn" style="background:#f8fafc; border:1px solid #cbd5e1; color:#334155; font-size:0.7rem; padding:0.2rem 0.45rem; font-weight:600;" data-action="viewCorePhotoLightbox('${escapeJsString(p.id)}')">查看</button>
              ${editBtn}${deleteBtn}
            </div>
          </div>`;
      }).join('');

      // 关联摆渡记录
      const eventsListHtml = events.map((item, idx) => {
        const p2 = item.payload || {};
        return `
          <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; padding:0.75rem; display:flex; flex-direction:column; gap:0.3rem;">
            <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.25rem;">
              <strong style="color:var(--primary); font-family:monospace; font-size:0.775rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(item.event_id)}</strong>
              <span style="color:#64748b; font-size:0.75rem; flex-shrink:0;">${new Date(item.timestamp).toLocaleString()}</span>
            </div>
            <div style="display:flex; flex-wrap:wrap; gap:0.3rem; font-size:0.775rem; color:#334155;">
              ${p2.location ? `<span style="background:#f0f9ff; color:#0369a1; border:1px solid #bae6fd; padding:0.1rem 0.4rem; border-radius:4px;">${escapeHtml(p2.location)}</span>` : ''}
              ${p2.transportation ? `<span style="background:#f0fdf4; color:#15803d; border:1px solid #bbf7d0; padding:0.1rem 0.4rem; border-radius:4px;">${escapeHtml(p2.transportation)}</span>` : ''}
              ${p2.person_name ? `<span style="background:#faf5ff; color:#7c3aed; border:1px solid #ddd6fe; padding:0.1rem 0.4rem; border-radius:4px; font-weight:600;">${escapeHtml(p2.person_name)}</span>` : ''}
            </div>
            <div style="font-size:0.7rem; color:#94a3b8; font-family:monospace; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="录入: ${escapeHtml(item.operator || '-')}">
              录入: ${escapeHtml((item.operator || '-').split('(')[0].trim())}
            </div>
          </div>`;
      }).join('');

      // 状态 badge
      const statusMap = { ACTIVE: ['#d1fae5', '#065f46', '进行中'], COMPLETED: ['#ede9fe', '#5b21b6', '已完成'], PAUSED: ['#fef3c7', '#92400e', '已暂停'] };
      const [sBg, sColor, sLabel] = statusMap[t.status] || ['#f1f5f9', '#475569', t.status || '未知'];

      drawerBody.innerHTML = `
        <div style="display:flex; flex-direction:column; gap:1rem; min-width:0;">

          <!-- 任务基础信息 -->
          <div style="background:#eff6ff; border:1px solid #bfdbfe; border-radius:10px; padding:0.85rem 1rem;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.6rem;">
              <span style="font-size:0.775rem; font-weight:700; color:#1e40af; text-transform:uppercase; letter-spacing:0.5px;">任务基础信息</span>
              <button class="btn" style="background:#fef3c7; border:1px solid #fde68a; color:#b45309; font-weight:700; padding:0.25rem 0.65rem; font-size:0.75rem; border-radius:6px; cursor:pointer; display:flex; align-items:center; gap:0.3rem;" data-action="openCoreTaskTrackMap('${escapeJsString(taskCode)}');">
                <svg class="icon-svg" viewBox="0 0 24 24" style="width:13px; height:13px;"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
                查看行动轨迹
              </button>
            </div>
            ${field('任务名称', `<strong style="color:#1e40af;">${escapeHtml(t.task_name)}</strong>`)}
            ${field('任务编号', escapeHtml(t.task_code || '-'), true)}
            ${field('任务状态', `<span style="background:${sBg}; color:${sColor}; padding:0.1rem 0.5rem; border-radius:4px; font-weight:600; font-size:0.775rem;">${sLabel}</span>`)}
            ${field('任务说明', escapeHtml(t.description || '无任务说明'))}
            ${field('创建人', escapeHtml(formatUserWithRealName(t.creator_username, t.creator_name)))}
          </div>

          <!-- 数据统计 -->
          <div style="background:#f0fdf4; border:1px solid #bbf7d0; border-radius:10px; padding:0.85rem 1rem;">
            <div style="font-size:0.775rem; font-weight:700; color:#15803d; margin-bottom:0.6rem; text-transform:uppercase; letter-spacing:0.5px;">汇聚统计</div>
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:0.75rem;">
              <div style="background:#ffffff; border-radius:8px; padding:0.65rem 0.75rem; text-align:center; border:1px solid #d1fae5;">
                <div style="font-size:1.5rem; font-weight:800; color:#1d4ed8;">${photos.length}</div>
                <div style="font-size:0.725rem; color:#64748b; margin-top:0.1rem;">累计图片（张）</div>
              </div>
              <div style="background:#ffffff; border-radius:8px; padding:0.65rem 0.75rem; text-align:center; border:1px solid #d1fae5;">
                <div style="font-size:1.5rem; font-weight:800; color:#15803d;">${events.length}</div>
                <div style="font-size:0.725rem; color:#64748b; margin-top:0.1rem;">摆渡次数（次）</div>
              </div>
            </div>
          </div>

          <!-- 图片全集 -->
          ${photos.length > 0 ? `
          <div style="background:#fafafa; border:1px solid #e2e8f0; border-radius:10px; padding:0.85rem 1rem;">
            <div style="font-size:0.775rem; font-weight:700; color:#334155; margin-bottom:0.65rem;">任务图片全集（${photos.length} 张）</div>
            <div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(130px, 1fr)); gap:0.6rem;">${photoCards}</div>
          </div>` : ''}

          <!-- 摆渡记录 -->
          ${events.length > 0 ? `
          <div style="background:#fafafa; border:1px solid #e2e8f0; border-radius:10px; padding:0.85rem 1rem;">
            <div style="font-size:0.775rem; font-weight:700; color:#334155; margin-bottom:0.65rem;">关联摆渡记录（${events.length} 笔）</div>
            <div style="display:flex; flex-direction:column; gap:0.5rem;">${eventsListHtml}</div>
          </div>` : ''}

        </div>
      `;

      // 恢复下载按钮显示
      if (dlBtn) dlBtn.style.display = '';

      const drawerOverlay = document.getElementById('drawerOverlay');
      if (drawerOverlay) drawerOverlay.classList.add('open');
    }
  } catch (e) {
    console.error('获取内网任务详情失败:', e);
  }
}

async function coreEditImage(imageId, taskCode) {
  const newDesc = prompt('请输入修改后的图片描述:');
  if (newDesc === null) return;

  try {
    const res = await fetch(`/api/images/${encodeURIComponent(imageId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: newDesc.trim() })
    });
    const json = await res.json();
    if (json.success) {
      alert(json.message);
      openTaskDetailDrawer(taskCode);
      fetchData();
    } else {
      alert('修改失败: ' + json.error);
    }
  } catch (e) {
    alert('修改异常: ' + e.message);
  }
}

async function coreDeleteImage(imageId, taskCode) {
  if (!confirm('确定要删除此图片吗？')) return;

  try {
    const res = await fetch(`/api/images/${encodeURIComponent(imageId)}`, {
      method: 'DELETE'
    });
    const json = await res.json();
    if (json.success) {
      alert(json.message);
      openTaskDetailDrawer(taskCode);
      fetchData();
    } else {
      alert('删除失败: ' + json.error);
    }
  } catch (e) {
    alert('删除异常: ' + e.message);
  }
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
    const matchTask = !task || e.task_name === task || e.task_code === task;
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
    tbody.innerHTML = `<tr><td colspan="10" style="text-align:center; padding:3rem; color:var(--text-muted);">未找到匹配的事件记录数据</td></tr>`;
    return;
  }

  const pagedData = filtered.slice((evtCurrentPage - 1) * evtPageSize, evtCurrentPage * evtPageSize);

  tbody.innerHTML = pagedData.map((item, idx) => {
    const globalIdx = (evtCurrentPage - 1) * evtPageSize + idx + 1;
    const p = item.payload || {};

    const imgsHtml = (item.files || []).map(f =>
      `<img src="${escapeHtml(assetUrl(f.url))}" style="width:24px; height:24px; object-fit:cover; border-radius:4px; border:1px solid var(--border-color); cursor:pointer; transition:transform 0.15s;" data-action-error="this.style.opacity='0.4';" data-action="event.stopPropagation(); openImageLightbox('${escapeJsString(assetUrl(f.url))}', '现场照片放大预览 (${escapeJsString(f.filename || '001.jpg')})')" title="点击在弹窗中放大查看">`
    ).join(' ');

    const personStr = p.person_name
      ? `<strong style="color:var(--primary); cursor:pointer; text-decoration:none;" data-action="event.stopPropagation(); showPersonDetailModal('${escapeJsString(encodeURIComponent(JSON.stringify(p)))}')" title="点击弹窗查看涉事人员完整档案">${escapeHtml(p.person_name)}</strong>`
      : '<span style="color:var(--text-muted);">-</span>';

    return `
      <tr style="cursor:pointer;" data-action="openEventDrawer('${escapeJsString(item.event_id)}')">
        <td class="col-idx">${globalIdx}</td>
        <td style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeHtml(item.event_id)}"><strong style="color:var(--primary); font-family:monospace; font-size:0.8rem;">${escapeHtml(item.event_id)}</strong></td>
        <td style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeHtml(item.task_name || '')}"><strong style="color:var(--text-main); font-weight:700; font-size:0.8rem;">${escapeHtml(item.task_name || '-')}</strong></td>
        <td style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:0.775rem; color:var(--text-sub);">${escapeHtml(new Date(item.submit_time || item.timestamp).toLocaleString())}</td>
        <td style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;"><span style="font-weight:600; color:var(--text-main); font-size:0.8rem;">${escapeHtml(formatUserForTable(item.operator_name || item.operator))}</span></td>
        <td style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeHtml(p.location || '-')}"><span style="font-weight:500; font-size:0.8rem;">${escapeHtml(p.location || '-')}</span></td>
        <td style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;"><span class="ai-tag-badge" style="background:#f0f9ff; color:#0369a1; border-color:#bae6fd; font-weight:600; font-size:0.75rem;">${escapeHtml(p.transportation || '-')}</span></td>
        <td style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${personStr}</td>
        <td><div style="display:flex; gap:0.25rem; flex-wrap:nowrap;">${imgsHtml || '<span style="color:var(--text-muted);">-</span>'}</div></td>
        <td style="text-align:left; white-space:nowrap;">
          <button class="btn btn-diode" style="padding:0.25rem 0.5rem; font-size:0.75rem;" data-action="event.stopPropagation(); openEventDrawer('${escapeJsString(item.event_id)}')">详情</button>
        </td>
      </tr>
    `;
  }).join('');
}

function changeEvtPageSize(val) { evtPageSize = parseInt(val); evtCurrentPage = 1; renderEvents(); }
function prevEvtPage() { if (evtCurrentPage > 1) { evtCurrentPage--; renderEvents(); } }
async function openCoreTaskTrackMap(taskCode) {
  try {
    const [taskRes, imgRes] = await Promise.all([
      fetch(`/api/tasks/${encodeURIComponent(taskCode)}`),
      fetch(`/api/tasks/${encodeURIComponent(taskCode)}/images?order=ASC`)
    ]);
    const taskJson = await taskRes.json();
    const imgJson = await imgRes.json();

    if (!taskRes.ok || !taskJson.success || !taskJson.data) {
      showToast(taskJson.error || '获取任务轨迹数据失败', 'error');
      return;
    }

    const task = taskJson.data;
    const events = Array.isArray(task.events) ? task.events : [];
    const images = Array.isArray(imgJson.data) ? imgJson.data : [];

    const trackPoints = [];
    events.forEach(evt => {
      const p = evt.payload || {};
      const lng = parseFloat(p.longitude);
      const lat = parseFloat(p.latitude);
      if (!isNaN(lng) && !isNaN(lat) && lng >= -180 && lng <= 180 && lat >= -90 && lat <= 90) {
        let imgUrl = null;
        if (Array.isArray(evt.files) && evt.files.length > 0) {
          const f = evt.files[0];
          imgUrl = f.url || (typeof f === 'string' ? f : null);
          if (imgUrl && typeof assetUrl === 'function') imgUrl = assetUrl(imgUrl);
        }

        trackPoints.push({
          eventId: evt.event_id,
          longitude: lng,
          latitude: lat,
          time: p.event_time || evt.timestamp || evt.created_at || '',
          location: p.location || task.task_name || '现场巡检点',
          personName: p.person_name || '',
          personIdCard: p.person_id_card || '',
          imageUrl: imgUrl
        });
      }
    });

    trackPoints.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());

    if (trackPoints.length === 0) {
      showToast('该任务暂无包含经纬度坐标的现场记录', 'warn');
      return;
    }

    if (typeof window.openTrackMapViewer === 'function') {
      window.openTrackMapViewer({
        title: `行动轨迹全景 - ${task.task_name}`,
        taskName: task.task_name,
        taskCode: task.task_code,
        trackPoints: trackPoints
      });
    } else {
      showToast('地图组件正在初始化，请稍后再试', 'warn');
    }
  } catch (err) {
    showToast(`加载轨迹失败: ${err.message}`, 'error');
  }
}

window.openCoreTaskTrackMap = openCoreTaskTrackMap;
window.openTaskTrackMap = openCoreTaskTrackMap;

Object.assign(window.VFusionActions = window.VFusionActions || {}, {
  fetchData, viewCorePhotoLightbox, switchCoreView, renderCoreDashboard, renderTaskMatrix,
  changeTaskPageSize, prevTaskPage, nextTaskPage, openTaskDetailDrawer, coreEditImage,
  coreDeleteImage, renderEvents, changeEvtPageSize, prevEvtPage, nextEvtPage, openCoreTaskTrackMap
});
