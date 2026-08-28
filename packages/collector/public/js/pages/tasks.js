let taskCurrentPage = 1, taskPageSize = 10;

async function loadTaskList() {
  try {
    const fetchFn = typeof apiFetch === 'function' ? apiFetch : fetch;
    const res = await fetchFn('/api/tasks');
    const json = await res.json();
    if (json.success) {
      cachedTasksData = json.data || [];
      updateTaskStats();
      renderTaskCards();
    }
  } catch (e) {
    console.error('加载任务列表失败:', e);
  }
}

function updateTaskStats() {
  const total = cachedTasksData.length;
  const active = cachedTasksData.filter(t => t.status === 'ACTIVE').length;
  const photos = cachedTasksData.reduce((acc, t) => acc + (t.photo_count || 0), 0);
  const shared = cachedTasksData.filter(t => t.is_shared).length;

  if (document.getElementById('statTaskTotal')) document.getElementById('statTaskTotal').innerText = total;
  if (document.getElementById('statTaskActive')) document.getElementById('statTaskActive').innerText = active;
  if (document.getElementById('statTaskPhotos')) document.getElementById('statTaskPhotos').innerText = photos;
  if (document.getElementById('statTaskShared')) document.getElementById('statTaskShared').innerText = shared;
}

function renderTaskCards() {
  const tbody = document.getElementById('taskTableBody');
  if (!tbody) return;

  const kw = (document.getElementById('taskSearchKeyword') ? document.getElementById('taskSearchKeyword').value : '').toLowerCase();
  const statusFilter = document.getElementById('taskStatusFilter') ? document.getElementById('taskStatusFilter').value : '';

  const filtered = cachedTasksData.filter(t => {
    if (!t) return false;
    const matchKw = !kw ||
      (t.task_name || '').toLowerCase().includes(kw) ||
      (t.task_code || '').toLowerCase().includes(kw) ||
      (t.description || '').toLowerCase().includes(kw) ||
      (t.creator_name || '').toLowerCase().includes(kw);
    const matchStatus = !statusFilter || t.status === statusFilter;
    return matchKw && matchStatus;
  });

  const totalCount = filtered.length;
  const totalPages = Math.ceil(totalCount / taskPageSize) || 1;
  if (taskCurrentPage > totalPages) taskCurrentPage = totalPages;
  if (taskCurrentPage < 1) taskCurrentPage = 1;

  if (document.getElementById('taskTotalCount')) document.getElementById('taskTotalCount').innerText = totalCount;
  if (document.getElementById('taskCurrentPageText')) document.getElementById('taskCurrentPageText').innerText = taskCurrentPage;
  if (document.getElementById('taskTotalPagesText')) document.getElementById('taskTotalPagesText').innerText = totalPages;
  if (document.getElementById('taskPrevBtn')) document.getElementById('taskPrevBtn').disabled = taskCurrentPage <= 1;
  if (document.getElementById('taskNextBtn')) document.getElementById('taskNextBtn').disabled = taskCurrentPage >= totalPages;

  if (totalCount === 0) {
    tbody.innerHTML = `<tr><td colspan="11" style="text-align:center; padding:2.5rem; color:var(--text-muted);">暂无匹配的发布任务记录</td></tr>`;
    return;
  }

  const paged = filtered.slice((taskCurrentPage - 1) * taskPageSize, taskCurrentPage * taskPageSize);

  tbody.innerHTML = paged.map((t, idx) => {
    const globalIdx = (taskCurrentPage - 1) * taskPageSize + idx + 1;
    const isActive = t.status === 'ACTIVE';
    const curUser = typeof currentUser !== 'undefined' ? currentUser : null;
    const isCreator = curUser && t.creator_username === curUser.username;
    const isAdmin = curUser && curUser.role === 'admin';
    const canManageTask = isCreator || isAdmin;

    const statusBadge = isActive
      ? `<span style="background:#e0f2fe; color:#0284c7; font-size:0.75rem; font-weight:700; padding:0.15rem 0.45rem; border-radius:4px; border:1px solid #bae6fd;">进行中</span>`
      : `<span style="background:#f1f5f9; color:#64748b; font-size:0.75rem; font-weight:600; padding:0.15rem 0.45rem; border-radius:4px; border:1px solid #cbd5e1;">已完成</span>`;

    const sharedUsersList = Array.isArray(t.shared_users) ? t.shared_users : [];
    const shareBadge = t.is_shared
      ? `<span style="background:#f3e8ff; color:#7e22ce; font-size:0.725rem; font-weight:600; padding:0.15rem 0.45rem; border-radius:4px;">全员公开</span>`
      : (sharedUsersList.length > 0
          ? `<span style="background:#e0f2fe; color:#0369a1; font-size:0.725rem; font-weight:600; padding:0.15rem 0.45rem; border-radius:4px;">共享给 ${sharedUsersList.length} 人</span>`
          : `<span style="background:#f8fafc; color:#94a3b8; font-size:0.725rem; font-weight:500; padding:0.15rem 0.45rem; border-radius:4px;">仅创建人</span>`);

    const latestTime = t.latest_timestamp ? new Date(t.latest_timestamp).toLocaleString() : '未提交';

    const editTaskBtn = canManageTask
      ? `<button class="btn" style="background:#eff6ff; border:1px solid #bfdbfe; color:#1d4ed8; font-size:0.75rem; padding:0.25rem 0.5rem;" data-action="openEditTaskModal('${escapeJsString(t.task_code)}')">编辑</button>`
      : `<button class="btn" style="background:#f8fafc; border:1px solid #cbd5e1; color:#94a3b8; font-size:0.75rem; padding:0.25rem 0.5rem; cursor:not-allowed;" title="无操作权限 (仅任务创建者或管理员可修改)" disabled>编辑</button>`;

    const deleteTaskBtn = canManageTask
      ? `<button class="btn" style="background:#fef2f2; border:1px solid #fecaca; color:#dc2626; font-size:0.75rem; padding:0.25rem 0.5rem;" data-action="handleDeleteTask('${escapeJsString(t.task_code)}')">删除</button>`
      : `<button class="btn" style="background:#f8fafc; border:1px solid #cbd5e1; color:#94a3b8; font-size:0.75rem; padding:0.25rem 0.5rem; cursor:not-allowed;" title="无操作权限 (仅任务创建者或管理员可删除)" disabled>删除</button>`;

    const shareManageBtn = canManageTask
      ? `<button class="btn" style="background:#fdf4ff; border:1px solid #f5d0fe; color:#a21caf; font-weight:600; padding:0.25rem 0.5rem; font-size:0.75rem;" data-action="openShareTaskModal('${escapeJsString(t.task_code)}')">分配共享</button>`
      : '';

    return `
      <tr>
        <td class="col-idx" style="text-align:center;">${globalIdx}</td>
        <td><strong style="color:#0f172a;">${escapeHtml(t.task_name)}</strong></td>
        <td><code style="color:#2563eb; font-weight:600;">${escapeHtml(t.task_code)}</code></td>
        <td style="max-width:200px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeHtml(t.description || '')}">${escapeHtml(t.description || '暂无描述')}</td>
        <td style="text-align:center; white-space:nowrap;"><span style="background:#eff6ff; color:#1d4ed8; font-weight:700; padding:0.15rem 0.45rem; border-radius:4px; font-size:0.75rem;">${t.photo_count || 0} 张</span></td>
        <td style="text-align:center; white-space:nowrap;"><span style="background:#f0fdf4; color:#15803d; font-weight:600; padding:0.15rem 0.45rem; border-radius:4px; font-size:0.75rem;">${t.contributor_count || 1} 人</span></td>
        <td style="text-align:center; white-space:nowrap;">${shareBadge}</td>
        <td style="text-align:center; white-space:nowrap;">${statusBadge}</td>
        <td style="white-space:nowrap;">${escapeHtml(formatUserForTable(t.creator_name || t.creator_username, t.creator_name))}</td>
        <td style="font-size:0.775rem; color:#64748b; white-space:nowrap;">${escapeHtml(latestTime)}</td>
        <td style="text-align:center; white-space:nowrap;">
          <div style="display:flex; gap:0.25rem; justify-content:center; align-items:center; flex-wrap:nowrap; white-space:nowrap;">
            <button class="btn btn-primary" style="padding:0.15rem 0.35rem; font-size:0.7rem; font-weight:600; white-space:nowrap; flex-shrink:0;" data-action="publishToTask('${escapeJsString(t.task_code)}')">上传图片</button>
            <button class="btn" style="background:#f0f9ff; border:1px solid #bae6fd; color:#0284c7; font-weight:600; padding:0.15rem 0.35rem; font-size:0.7rem; white-space:nowrap; flex-shrink:0;" data-action="selectTaskForGallery('${escapeJsString(t.task_code)}')">图片库</button>
            <button class="btn" style="background:#f8fafc; border:1px solid #cbd5e1; color:#334155; font-weight:600; padding:0.15rem 0.35rem; font-size:0.7rem; white-space:nowrap; flex-shrink:0;" data-action="openTaskDetailModal('${escapeJsString(t.task_code)}')">任务详情</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function changeTaskPageSize(val) { taskPageSize = parseInt(val); taskCurrentPage = 1; renderTaskCards(); }
function prevTaskPage() { if (taskCurrentPage > 1) { taskCurrentPage--; renderTaskCards(); } }
function nextTaskPage() { taskCurrentPage++; renderTaskCards(); }

function escapeJsString(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\\/g, '\\\\').replace(/'/g, "\\&#39;").replace(/"/g, '&quot;').replace(/\r?\n/g, '\\n');
}

function openCreateTaskModal() {
  document.getElementById('newTaskName').value = '';
  document.getElementById('newTaskCode').value = '';
  document.getElementById('newTaskDesc').value = '';
  document.getElementById('newTaskIsShared').checked = true;
  document.getElementById('createTaskModal').style.display = 'flex';
}

function closeCreateTaskModal() {
  document.getElementById('createTaskModal').style.display = 'none';
}

async function handleCreateTask(e) {
  e.preventDefault();
  const task_name = document.getElementById('newTaskName').value.trim();
  const task_code = document.getElementById('newTaskCode').value.trim();
  const description = document.getElementById('newTaskDesc').value.trim();
  const is_shared = document.getElementById('newTaskIsShared').checked;

  try {
    const fetchFn = typeof apiFetch === 'function' ? apiFetch : fetch;
    const res = await fetchFn('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_name, task_code, description, is_shared })
    });
    const json = await res.json();
    if (json.success) {
      showToast(`任务 [${json.data.task_name}] 创建成功！`);
      closeCreateTaskModal();
      await loadTaskList();
    } else {
      showToast(json.error, 'error');
    }
  } catch (err) {
    showToast('创建任务请求失败: ' + err.message, 'error');
  }
}

function openJoinTaskModal() {
  document.getElementById('joinShareCode').value = '';
  document.getElementById('joinTaskModal').style.display = 'flex';
}

function closeJoinTaskModal() {
  document.getElementById('joinTaskModal').style.display = 'none';
}

async function handleJoinTask(e) {
  e.preventDefault();
  const share_code = document.getElementById('joinShareCode').value.trim();

  try {
    const fetchFn = typeof apiFetch === 'function' ? apiFetch : fetch;
    const res = await fetchFn('/api/tasks/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ share_code })
    });
    const json = await res.json();
    if (json.success) {
      showToast(`已成功接入团队任务: ${json.data.task_name}`);
      closeJoinTaskModal();
      await loadTaskList();
      publishToTask(json.data.task_code);
    } else {
      showToast(json.error, 'error');
    }
  } catch (err) {
    showToast('加入任务失败: ' + err.message, 'error');
  }
}

function publishToTask(taskCode) {
  if (typeof selectTaskForPublish === 'function') {
    selectTaskForPublish(taskCode);
  } else {
    localStorage.setItem('vfusion_selected_task_code', taskCode);
  }
  switchTab('tab-publish');
}

function copyShareCode(shareCode) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(shareCode).then(() => {
      showToast(`已复制任务分享码: ${shareCode}`);
    }).catch(() => {
      prompt('请复制以下任务分享码:', shareCode);
    });
  } else {
    prompt('请复制以下任务分享码:', shareCode);
  }
}

async function toggleTaskStatus(taskCode, status) {
  try {
    const fetchFn = typeof apiFetch === 'function' ? apiFetch : fetch;
    const res = await fetchFn(`/api/tasks/${encodeURIComponent(taskCode)}/status`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status })
    });
    const json = await res.json();
    if (json.success) {
      showToast(json.message);
      await loadTaskList();
    } else {
      showToast(json.error, 'error');
    }
  } catch (e) {
    showToast('更新任务状态失败: ' + e.message, 'error');
  }
}

async function openTaskDetail(taskCode) {
  try {
    const fetchFn = typeof apiFetch === 'function' ? apiFetch : fetch;
    const res = await fetchFn(`/api/tasks/${encodeURIComponent(taskCode)}`);
    const json = await res.json();
    if (json.success) {
      const t = json.data;
      document.getElementById('taskDetailModalTitle').innerText = t.task_name || '任务存照详情';
      document.getElementById('taskDetailModalCode').innerText = `任务编号: ${t.task_code} | 分享码: ${t.share_code || t.task_code}`;

      const events = t.events || [];
      const content = document.getElementById('taskDetailModalContent');

      if (events.length === 0) {
        content.innerHTML = `<div style="text-align:center; padding:2.5rem; color:var(--text-muted);">本任务下暂未提交任何现场照片数据</div>`;
      } else {
        content.innerHTML = events.map(evt => {
          const files = evt.files || [];
          const payload = evt.payload || {};
          const imgsHtml = files.map(f =>
            `<img src="${escapeHtml(assetUrl(f.url))}" style="width:72px; height:72px; object-fit:cover; border-radius:6px; border:1px solid #cbd5e1; cursor:pointer;" data-action-error="this.style.opacity='0.4'; this.title='图片无法加载';" data-action="openImageLightbox('${escapeJsString(assetUrl(f.url))}', '${escapeJsString(t.task_name)} - 现场照片')">`
          ).join(' ');

          return `
            <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; padding:0.85rem 1rem;">
              <div style="display:flex; justify-content:space-between; font-size:0.8rem; margin-bottom:0.4rem;">
                <span style="font-weight:700; color:var(--primary);">单据ID: ${escapeHtml(evt.event_id)}</span>
                <span style="color:#64748b;">${new Date(evt.timestamp).toLocaleString()}</span>
              </div>
              <div style="font-size:0.825rem; color:#334155; margin-bottom:0.5rem;">
                <strong>提交人员:</strong> ${escapeHtml(evt.operator || '-')} |
                <strong>发生地点:</strong> ${escapeHtml(payload.location || '-')}
                ${payload.person_name ? ` | <strong>涉事人员:</strong> <span style="color:var(--primary);">${escapeHtml(payload.person_name)}</span>` : ''}
              </div>
              <div style="display:flex; gap:0.5rem; flex-wrap:wrap; margin-top:0.4rem;">
                ${imgsHtml || '<span style="font-size:0.75rem; color:#94a3b8;">无照片</span>'}
              </div>
            </div>
          `;
        }).join('');
      }

      document.getElementById('taskDetailModal').style.display = 'flex';
    }
  } catch (e) {
    showToast('获取任务详情失败: ' + e.message, 'error');
  }
}

function closeTaskDetailModal() {
  document.getElementById('taskDetailModal').style.display = 'none';
}

function openEditTaskModal(taskCode) {
  const task = cachedTasksData.find(t => t.task_code === taskCode);
  if (!task) return;

  if (document.getElementById('editTaskCode')) document.getElementById('editTaskCode').value = task.task_code;
  if (document.getElementById('editTaskName')) document.getElementById('editTaskName').value = task.task_name || '';
  if (document.getElementById('editTaskDesc')) document.getElementById('editTaskDesc').value = task.description || '';
  if (document.getElementById('editTaskIsShared')) document.getElementById('editTaskIsShared').checked = Boolean(task.is_shared);
  if (document.getElementById('editTaskStatus')) document.getElementById('editTaskStatus').value = task.status || 'ACTIVE';

  const modal = document.getElementById('editTaskModal');
  if (modal) modal.style.display = 'flex';
}

function closeEditTaskModal() {
  const modal = document.getElementById('editTaskModal');
  if (modal) modal.style.display = 'none';
}

async function handleSaveTaskEdit(e) {
  e.preventDefault();
  const task_code = document.getElementById('editTaskCode').value;
  const task_name = document.getElementById('editTaskName').value.trim();
  const description = document.getElementById('editTaskDesc').value.trim();
  const is_shared = document.getElementById('editTaskIsShared').checked;
  const status = document.getElementById('editTaskStatus').value;

  try {
    const fetchFn = typeof apiFetch === 'function' ? apiFetch : fetch;
    const res = await fetchFn(`/api/tasks/${encodeURIComponent(task_code)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_name, description, is_shared, status })
    });
    const json = await res.json();
    if (json.success) {
      showToast(json.message);
      closeEditTaskModal();
      await loadTaskList();
    } else {
      showToast(json.error, 'error');
    }
  } catch (err) {
    showToast('更新任务失败: ' + err.message, 'error');
  }
}

async function handleDeleteTask(taskCode) {
  if (!confirm(`确定要删除任务 [${taskCode}] 吗？删除后此任务记录不可恢复。`)) return;

  try {
    const fetchFn = typeof apiFetch === 'function' ? apiFetch : fetch;
    const res = await fetchFn(`/api/tasks/${encodeURIComponent(taskCode)}`, {
      method: 'DELETE'
    });
    const json = await res.json();
    if (json.success) {
      showToast(json.message);
      await loadTaskList();
    } else {
      showToast(json.error, 'error');
    }
  } catch (err) {
    showToast('删除任务失败: ' + err.message, 'error');
  }
}

let currentPersonnelTaskCode = '';
let tpCurrentPage = 1, tpPageSize = 5;
let cachedTpData = [];

async function openTaskPersonnelModal(taskCode) {
  currentPersonnelTaskCode = taskCode;
  tpCurrentPage = 1;
  const task = cachedTasksData.find(t => t.task_code === taskCode);
  document.getElementById('tpTaskCode').value = taskCode;
  document.getElementById('tpName').value = '';
  document.getElementById('tpIdCard').value = '';
  document.getElementById('tpDomicile').value = '';
  document.getElementById('taskPersonnelModalSub').innerText = `当前关联任务: ${task ? task.task_name : taskCode} (${taskCode})`;
  document.getElementById('taskPersonnelModal').style.display = 'flex';
  await loadTaskPersonnelTable(taskCode);
}

function closeTaskPersonnelModal() {
  document.getElementById('taskPersonnelModal').style.display = 'none';
}

async function loadTaskPersonnelTable(taskCode) {
  const tbody = document.getElementById('tpTableBody');
  if (!tbody) return;
  try {
    const fetchFn = typeof apiFetch === 'function' ? apiFetch : fetch;
    const res = await fetchFn(`/api/personnel?task_code=${encodeURIComponent(taskCode)}`);
    const json = await res.json();
    cachedTpData = json.success ? (json.data || []) : [];
    renderTaskPersonnelTable();
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center; color:red;">加载失败: ${escapeHtml(e.message)}</td></tr>`;
  }
}

function renderTaskPersonnelTable() {
  const tbody = document.getElementById('tpTableBody');
  if (!tbody) return;

  const totalCount = cachedTpData.length;
  const totalPages = Math.ceil(totalCount / tpPageSize) || 1;
  if (tpCurrentPage > totalPages) tpCurrentPage = totalPages;
  if (tpCurrentPage < 1) tpCurrentPage = 1;

  if (document.getElementById('tpTotalCount')) document.getElementById('tpTotalCount').innerText = totalCount;
  if (document.getElementById('tpCurrentPageText')) document.getElementById('tpCurrentPageText').innerText = tpCurrentPage;
  if (document.getElementById('tpTotalPagesText')) document.getElementById('tpTotalPagesText').innerText = totalPages;
  if (document.getElementById('tpPrevBtn')) document.getElementById('tpPrevBtn').disabled = tpCurrentPage <= 1;
  if (document.getElementById('tpNextBtn')) document.getElementById('tpNextBtn').disabled = tpCurrentPage >= totalPages;

  if (totalCount === 0) {
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center; padding:1.5rem; color:#94a3b8;">本任务暂无关联涉事人员记录</td></tr>`;
    return;
  }

  const paged = cachedTpData.slice((tpCurrentPage - 1) * tpPageSize, tpCurrentPage * tpPageSize);
  tbody.innerHTML = paged.map(p => `
    <tr style="border-bottom:1px solid #f1f5f9;">
      <td style="padding:0.45rem 0.6rem; font-weight:600; color:#1e293b;">${escapeHtml(p.name)}</td>
      <td style="padding:0.45rem 0.6rem; font-family:monospace; color:#2563eb;">${escapeHtml(p.id_card)}</td>
      <td style="padding:0.45rem 0.6rem; color:#475569;">${escapeHtml(p.domicile || '-')}</td>
      <td style="padding:0.45rem 0.6rem; text-align:center;">
        <button class="btn" style="background:#fef2f2; border:1px solid #fecaca; color:#dc2626; font-size:0.75rem; padding:0.2rem 0.45rem;" data-action="handleDeleteTaskPersonnel('${escapeJsString(p.id)}')">删除</button>
      </td>
    </tr>
  `).join('');
}

function changeTpPageSize(val) { tpPageSize = parseInt(val); tpCurrentPage = 1; renderTaskPersonnelTable(); }
function prevTpPage() { if (tpCurrentPage > 1) { tpCurrentPage--; renderTaskPersonnelTable(); } }
function nextTpPage() { tpCurrentPage++; renderTaskPersonnelTable(); }

async function handleAddTaskPersonnel(e) {
  e.preventDefault();
  const task_code = document.getElementById('tpTaskCode').value;
  const name = document.getElementById('tpName').value.trim();
  const id_card = document.getElementById('tpIdCard').value.trim();
  const domicile = document.getElementById('tpDomicile').value.trim();

  try {
    const fetchFn = typeof apiFetch === 'function' ? apiFetch : fetch;
    const res = await fetchFn('/api/personnel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, id_card, domicile, task_code })
    });
    const json = await res.json();
    if (json.success) {
      showToast(json.message || '人员登记成功');
      document.getElementById('tpName').value = '';
      document.getElementById('tpIdCard').value = '';
      document.getElementById('tpDomicile').value = '';
      await loadTaskPersonnelTable(task_code);
    } else {
      showToast(json.error, 'error');
    }
  } catch (err) {
    showToast('添加涉事人员失败: ' + err.message, 'error');
  }
}

async function handleDeleteTaskPersonnel(personId) {
  if (!confirm('确定要从涉事人员库中删除此记录吗？')) return;
  try {
    const fetchFn = typeof apiFetch === 'function' ? apiFetch : fetch;
    const res = await fetchFn(`/api/personnel/${encodeURIComponent(personId)}`, {
      method: 'DELETE'
    });
    const json = await res.json();
    if (json.success) {
      showToast(json.message);
      await loadTaskPersonnelTable(currentPersonnelTaskCode);
    } else {
      showToast(json.error, 'error');
    }
  } catch (err) {
    showToast('删除人员异常: ' + err.message, 'error');
  }
}

async function openShareTaskModal(taskCode) {
  const task = cachedTasksData.find(t => t.task_code === taskCode);
  if (!task) return;

  document.getElementById('shareTaskCodeInput').value = taskCode;
  document.getElementById('shareTaskModalSub').innerText = `当前分配任务: ${task.task_name} (${taskCode})`;
  document.getElementById('shareTaskIsShared').checked = Boolean(task.is_shared);

  const container = document.getElementById('shareTaskUserList');
  container.innerHTML = `<div style="text-align:center; padding:1rem; color:#94a3b8;">正在加载系统用户列表...</div>`;
  document.getElementById('shareTaskModal').style.display = 'flex';

  try {
    const fetchFn = typeof apiFetch === 'function' ? apiFetch : fetch;
    const res = await fetchFn('/api/users/list');
    const json = await res.json();
    const users = json.success ? (json.data || []) : [];
    const currentShared = Array.isArray(task.shared_users) ? task.shared_users : [];

    if (users.length === 0) {
      container.innerHTML = `<div style="text-align:center; padding:1rem; color:#94a3b8;">暂无可选择的其他系统用户</div>`;
      return;
    }

    container.innerHTML = users.map(u => {
      const isChecked = currentShared.includes(u.username) ? 'checked' : '';
      const isCreator = u.username === task.creator_username;
      const labelTag = isCreator ? '<span style="color:#0284c7; font-size:0.75rem; margin-left:0.4rem; font-weight:bold;">(创建者)</span>' : '';

      return `
        <label style="display:flex; align-items:center; justify-content:space-between; padding:0.45rem 0.75rem; background:#ffffff; border:1px solid #cbd5e1; border-radius:6px; cursor:pointer;">
          <span style="font-size:0.85rem; font-weight:600; color:#1e293b;">
            ${escapeHtml(formatUserWithRealName(u.username, u.name))} ${labelTag}
          </span>
          <input type="checkbox" name="shareUserCheck" value="${escapeHtml(u.username)}" ${isChecked} ${isCreator ? 'disabled checked' : ''} style="width:16px; height:16px; cursor:pointer;">
        </label>
      `;
    }).join('');
  } catch (e) {
    container.innerHTML = `<div style="text-align:center; color:red;">加载用户列表失败: ${escapeHtml(e.message)}</div>`;
  }
}

function closeShareTaskModal() {
  document.getElementById('shareTaskModal').style.display = 'none';
}

async function handleSaveTaskShare(e) {
  e.preventDefault();
  const taskCode = document.getElementById('shareTaskCodeInput').value;
  const is_shared = document.getElementById('shareTaskIsShared').checked;
  const checkboxes = document.querySelectorAll('input[name="shareUserCheck"]:checked');
  const shared_users = Array.from(checkboxes).map(cb => cb.value);

  try {
    const fetchFn = typeof apiFetch === 'function' ? apiFetch : fetch;
    const res = await fetchFn(`/api/tasks/${encodeURIComponent(taskCode)}/share`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_shared, shared_users })
    });
    const json = await res.json();
    if (json.success) {
      showToast(json.message || '共享分配更新成功');
      closeShareTaskModal();
      await loadTaskList();
    } else {
      showToast(json.error, 'error');
    }
  } catch (err) {
    showToast('更新共享失败: ' + err.message, 'error');
  }
}

async function openTaskDetailModal(taskCode) {
  const task = cachedTasksData.find(t => t.task_code === taskCode);
  if (!task) return;

  const curUser = typeof currentUser !== 'undefined' ? currentUser : null;
  const isCreator = curUser && task.creator_username === curUser.username;
  const isAdmin = curUser && curUser.role === 'admin';
  const canManageTask = isCreator || isAdmin;

  document.getElementById('taskDetailModalTitle').innerText = task.task_name;
  document.getElementById('taskDetailModalCode').innerText = `任务编号: ${task.task_code}`;

  const container = document.getElementById('taskDetailModalContent');
  container.innerHTML = `<div style="text-align:center; padding:2rem; color:#94a3b8;">正在加载任务综合详情...</div>`;
  document.getElementById('taskDetailModal').style.display = 'flex';

  const sharedUsersList = Array.isArray(task.shared_users) ? task.shared_users : [];
  const shareModeText = task.is_shared
    ? '全员公开共享'
    : (sharedUsersList.length > 0 ? `共享给 ${sharedUsersList.length} 人 (${sharedUsersList.join(', ')})` : '仅创建人');

  const statusText = task.status === 'ACTIVE' ? '进行中' : '已完成';
  const statusColor = task.status === 'ACTIVE' ? '#0284c7' : '#64748b';

  const shareManageBtnHtml = canManageTask
    ? `<button class="btn" style="background:#fdf4ff; border:1px solid #f5d0fe; color:#a21caf; font-weight:600; padding:0.4rem 0.85rem; font-size:0.8rem; border-radius:6px; cursor:pointer;" data-action="closeTaskDetailModal(); openShareTaskModal('${escapeJsString(task.task_code)}');">共享权限</button>`
    : '';

  const editTaskBtnHtml = canManageTask
    ? `<button class="btn" style="background:#eff6ff; border:1px solid #bfdbfe; color:#1d4ed8; font-weight:600; padding:0.4rem 0.85rem; font-size:0.8rem; border-radius:6px; cursor:pointer;" data-action="closeTaskDetailModal(); openEditTaskModal('${escapeJsString(task.task_code)}');">编辑任务</button>`
    : '';

  const deleteTaskBtnHtml = canManageTask
    ? `<button class="btn" style="background:#fef2f2; border:1px solid #fecaca; color:#dc2626; font-weight:600; padding:0.4rem 0.85rem; font-size:0.8rem; border-radius:6px; cursor:pointer;" data-action="closeTaskDetailModal(); handleDeleteTask('${escapeJsString(task.task_code)}');">删除任务</button>`
    : '';

  let html = `
    <!-- 1. 任务基本信息卡片 -->
    <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:10px; padding:1rem 1.25rem;">
      <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap:0.75rem; margin-bottom:0.75rem;">
        <div><span style="font-size:0.75rem; color:#64748b;">任务状态：</span><strong style="color:${statusColor}; font-size:0.85rem;">${escapeHtml(statusText)}</strong></div>
        <div><span style="font-size:0.75rem; color:#64748b;">共享模式：</span><strong style="color:#7e22ce; font-size:0.85rem;">${escapeHtml(shareModeText)}</strong></div>
        <div><span style="font-size:0.75rem; color:#64748b;">创建人：</span><span style="font-size:0.85rem; font-weight:600; color:#1e293b;">${escapeHtml(formatUserWithRealName(task.creator_username, task.creator_name))}</span></div>
        <div><span style="font-size:0.75rem; color:#64748b;">创建时间：</span><span style="font-size:0.8rem; color:#475569;">${escapeHtml(new Date(task.created_at).toLocaleString())}</span></div>
        <div><span style="font-size:0.75rem; color:#64748b;">已存抓拍照片：</span><span style="font-size:0.85rem; font-weight:700; color:#2563eb;">${task.photo_count || 0} 张</span></div>
        <div><span style="font-size:0.75rem; color:#64748b;">参与协作人数：</span><span style="font-size:0.85rem; font-weight:700; color:#16a34a;">${task.contributor_count || 1} 人</span></div>
      </div>
      <div style="border-top:1px dashed #cbd5e1; padding-top:0.6rem; margin-top:0.4rem;">
        <span style="font-size:0.75rem; color:#64748b; font-weight:600; display:block; margin-bottom:0.2rem;">任务说明与抓拍指示：</span>
        <div style="font-size:0.85rem; color:#334155; line-height:1.4; white-space:pre-wrap; background:#ffffff; border:1px solid #e2e8f0; border-radius:6px; padding:0.5rem 0.75rem;">${escapeHtml(task.description || '暂无详细描述说明')}</div>
      </div>
    </div>

    <!-- 2. 核心功能操作整合按钮组 -->
    <div>
      <label style="font-size:0.825rem; font-weight:700; color:#334155; display:block; margin-bottom:0.5rem;">任务功能合并快捷操作区：</label>
      <div style="display:flex; gap:0.5rem; flex-wrap:wrap; background:#ffffff; border:1px solid #e2e8f0; border-radius:10px; padding:0.75rem;">
        <button class="btn btn-primary" style="padding:0.4rem 0.85rem; font-size:0.8rem; font-weight:600; border-radius:6px; cursor:pointer;" data-action="closeTaskDetailModal(); publishToTask('${escapeJsString(task.task_code)}');">上传图片</button>
        <button class="btn" style="background:#f0f9ff; border:1px solid #bae6fd; color:#0284c7; font-weight:600; padding:0.4rem 0.85rem; font-size:0.8rem; border-radius:6px; cursor:pointer;" data-action="closeTaskDetailModal(); selectTaskForGallery('${escapeJsString(task.task_code)}');">图片库</button>
        <button class="btn" style="background:#f0fdf4; border:1px solid #bbf7d0; color:#15803d; font-weight:600; padding:0.4rem 0.85rem; font-size:0.8rem; border-radius:6px; cursor:pointer;" data-action="openTaskPersonnelModal('${escapeJsString(task.task_code)}');">涉事人员</button>
        ${shareManageBtnHtml}
        ${editTaskBtnHtml}
        ${deleteTaskBtnHtml}
      </div>
    </div>

    <!-- 3. 本任务最新抓拍照片概览 (网格) -->
    <div>
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.5rem;">
        <label style="font-size:0.825rem; font-weight:700; color:#334155;">本任务现场照片概览 (${task.photo_count || 0} 张)</label>
      </div>
      <div id="taskDetailPhotosGrid" style="display:grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap:0.6rem; max-height:220px; overflow-y:auto; background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; padding:0.6rem;">
        <div style="text-align:center; padding:1.5rem; color:#94a3b8; grid-column: 1 / -1;">正在加载照片列表中...</div>
      </div>
    </div>
  `;

  container.innerHTML = html;

  try {
    const fetchFn = typeof apiFetch === 'function' ? apiFetch : fetch;
    const res = await fetchFn(`/api/tasks/${encodeURIComponent(taskCode)}/images`);
    const json = await res.json();
    const photosGrid = document.getElementById('taskDetailPhotosGrid');
    if (json.success && Array.isArray(json.data) && json.data.length > 0) {
      photosGrid.innerHTML = json.data.map(img => `
        <div style="position:relative; aspect-ratio:4/3; border-radius:6px; overflow:hidden; border:1px solid #cbd5e1; background:#000; cursor:pointer;" data-action="openImageLightbox('${escapeJsString(assetUrl(img.url))}', '${escapeJsString(img.description || task.task_name)}')">
          <img src="${escapeHtml(assetUrl(img.url))}" style="width:100%; height:100%; object-fit:cover;" data-action-error="this.style.opacity='0.4';">
          <div style="position:absolute; bottom:0; left:0; right:0; background:rgba(0,0,0,0.6); color:#fff; font-size:0.65rem; padding:2px 4px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
            ${escapeHtml(img.uploader_name || '操作员')}
          </div>
        </div>
      `).join('');
    } else {
      if (photosGrid) photosGrid.innerHTML = `<div style="text-align:center; padding:1.5rem; color:#94a3b8; grid-column: 1 / -1;">本任务暂未上传任何抓拍照片</div>`;
    }
  } catch (e) {
    const photosGrid = document.getElementById('taskDetailPhotosGrid');
    if (photosGrid) photosGrid.innerHTML = `<div style="text-align:center; padding:1.5rem; color:#94a3b8; grid-column: 1 / -1;">未获取到照片数据</div>`;
  }
}

function closeTaskDetailModal() {
  document.getElementById('taskDetailModal').style.display = 'none';
}
