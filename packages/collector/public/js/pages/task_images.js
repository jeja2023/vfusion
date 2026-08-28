let galleryImages = [];
let gallerySortOrder = 'ASC'; // 默认：时间正序 (Chronological Order)
let currentTaskInfo = null;

async function ensureTaskImagesTemplateLoaded() {
  const container = document.getElementById('tab-task-images');
  if (container && (!container.innerHTML.trim() || !document.getElementById('galleryTaskSelect'))) {
    try {
      const res = await fetch('pages/task_images.html?v=' + Date.now());
      if (res.ok) {
        container.innerHTML = await res.text();
      }
    } catch (e) {
      console.error('动态加载 task_images.html 失败:', e);
    }
  }
}

async function initTaskImagesPage(presetTaskCode = null) {
  try {
    await ensureTaskImagesTemplateLoaded();
    if (presetTaskCode && typeof presetTaskCode === 'string') {
      localStorage.setItem('vfusion_selected_task_code', presetTaskCode);
    }
    const select = document.getElementById('galleryTaskSelect');
    if (!select) {
      console.error('无法找到 galleryTaskSelect 元素');
      return;
    }
    const fetchFn = typeof apiFetch === 'function' ? apiFetch : fetch;
    const res = await fetchFn('/api/tasks');
    const json = await res.json();

    if (json.success) {
      const tasks = json.data || [];
      const select = document.getElementById('galleryTaskSelect');
      if (!select) return;

      if (tasks.length === 0) {
        select.innerHTML = '<option value="">暂无可展示的任务</option>';
        const grid = document.getElementById('galleryImageGrid');
        if (grid) grid.innerHTML = '<div style="grid-column:1/-1; text-align:center; padding:3rem; color:var(--text-muted);">暂无任何发布任务</div>';
        return;
      }

      select.innerHTML = tasks.map(t =>
        `<option value="${escapeHtml(t.task_code)}">${escapeHtml(t.task_name)} (${escapeHtml(t.task_code)}) - ${t.photo_count || 0}张照片</option>`
      ).join('');

      let targetCode = localStorage.getItem('vfusion_selected_task_code') || tasks[0].task_code;
      if (!tasks.some(t => t.task_code === targetCode)) {
        targetCode = tasks[0].task_code;
      }

      localStorage.setItem('vfusion_selected_task_code', targetCode);
      select.value = targetCode;

      const kwInput = document.getElementById('gallerySearchKeyword');
      if (kwInput) kwInput.value = '';

      await loadTaskImagesPage();
    }
  } catch (e) {
    console.error('初始化任务图片页面失败:', e);
  }
}

async function loadTaskImagesPage() {
  const select = document.getElementById('galleryTaskSelect');
  if (!select) return;
  const taskCode = select.value;
  if (!taskCode) return;

  try {
    const fetchFn = typeof apiFetch === 'function' ? apiFetch : fetch;
    const res = await fetchFn(`/api/tasks/${encodeURIComponent(taskCode)}/images?order=${gallerySortOrder}`);
    const json = await res.json();

    if (json.success) {
      galleryImages = json.data || [];
      currentTaskInfo = json.task || null;
      renderGalleryGrid();
    } else {
      showToast(json.error, 'error');
    }
  } catch (e) {
    showToast('加载任务图片失败: ' + e.message, 'error');
  }
}

function toggleImageSortOrder() {
  gallerySortOrder = gallerySortOrder === 'ASC' ? 'DESC' : 'ASC';
  const label = document.getElementById('sortOrderLabel');
  if (label) {
    label.innerText = gallerySortOrder === 'ASC' ? '时间正序 (从早到晚)' : '时间倒序 (从晚到早)';
  }
  loadTaskImagesPage();
}

function renderGalleryGrid() {
  const container = document.getElementById('galleryImageGrid');
  if (!container) return;

  const kw = (document.getElementById('gallerySearchKeyword') ? document.getElementById('gallerySearchKeyword').value : '').toLowerCase();

  const filtered = galleryImages.filter(img => {
    if (!img) return false;
    const matchKw = !kw ||
      (img.description || '').toLowerCase().includes(kw) ||
      (img.location || '').toLowerCase().includes(kw) ||
      (img.uploader_name || '').toLowerCase().includes(kw) ||
      (img.uploader_username || '').toLowerCase().includes(kw) ||
      (img.filename || '').toLowerCase().includes(kw);
    return matchKw;
  });

  const countTag = document.getElementById('galleryCountTag');
  if (countTag) countTag.innerText = `共 ${filtered.length} 张照片`;

  if (filtered.length === 0) {
    container.innerHTML = `<div style="grid-column:1/-1; text-align:center; padding:3.5rem; color:var(--text-muted); background:#ffffff; border-radius:10px; border:1px dashed #cbd5e1;">本任务下暂未包含匹配的照片存照数据</div>`;
    return;
  }

  container.innerHTML = filtered.map((img, idx) => {
    const formattedTime = img.timestamp ? new Date(img.timestamp).toLocaleString() : '未知时间';
    const isOwn = img.is_own;
    const canEdit = img.can_edit;
    const canDelete = img.can_delete;

    const editBtn = canEdit
      ? `<button class="btn" style="background:#eff6ff; border:1px solid #bfdbfe; color:#1d4ed8; font-size:0.75rem; padding:0.3rem 0.55rem; font-weight:600;" data-action="openEditImageModal('${escapeJsString(img.id)}')">编辑</button>`
      : `<button class="btn" style="background:#f8fafc; border:1px solid #e2e8f0; color:#94a3b8; font-size:0.75rem; padding:0.3rem 0.55rem; cursor:not-allowed;" title="无编辑权限 (仅上传者/任务创建者/管理员可修改)" disabled>编辑</button>`;

    const deleteBtn = canDelete
      ? `<button class="btn" style="background:#fef2f2; border:1px solid #fecaca; color:#dc2626; font-size:0.75rem; padding:0.3rem 0.55rem; font-weight:600;" data-action="handleDeleteImage('${escapeJsString(img.id)}')">删除</button>`
      : `<button class="btn" style="background:#f8fafc; border:1px solid #e2e8f0; color:#94a3b8; font-size:0.75rem; padding:0.3rem 0.55rem; cursor:not-allowed;" title="无删除权限 (仅上传者/任务创建者/管理员可删除)" disabled>删除</button>`;

    return `
      <div style="background:#ffffff; border:1px solid #e2e8f0; border-radius:10px; overflow:hidden; display:flex; flex-direction:column; box-shadow:0 2px 5px rgba(0,0,0,0.04); transition:transform 0.15s ease, box-shadow 0.15s ease;">
        <!-- 顶部时间线与顺序 Badge -->
        <div style="background:#f8fafc; border-bottom:1px solid #f1f5f9; padding:0.5rem 0.85rem; display:flex; justify-content:space-between; align-items:center; font-size:0.75rem;">
          <span style="background:#0284c7; color:#fff; font-weight:700; padding:0.1rem 0.45rem; border-radius:4px;"># ${idx + 1}</span>
          <span style="color:#64748b; font-weight:600; display:flex; align-items:center; gap:0.25rem;">
            时间: ${formattedTime}
          </span>
        </div>

        <!-- 图片预览区 -->
        <div style="position:relative; width:100%; height:185px; background:#0f172a; overflow:hidden; cursor:pointer;" data-action="viewGalleryImageLightbox('${escapeJsString(img.id)}')">
          <img src="${escapeHtml(assetUrl(img.url))}" style="width:100%; height:100%; object-fit:cover; transition:transform 0.3s ease;" data-action-error="this.style.opacity='0.4'; this.title='图片未找到或无法加载';" data-action-mouseover="this.style.transform='scale(1.05)'" data-action-mouseout="this.style.transform='scale(1)'">
          ${isOwn ? `<span style="position:absolute; top:8px; right:8px; background:rgba(37,99,235,0.9); color:#fff; font-size:0.7rem; font-weight:700; padding:0.15rem 0.45rem; border-radius:4px; backdrop-filter:blur(4px);">我上传的</span>` : ''}
        </div>

        <!-- 详细元数据面板 -->
        <div style="padding:0.75rem 0.85rem; flex:1; display:flex; flex-direction:column; justify-content:space-between;">
          <div style="display:flex; justify-content:space-between; align-items:center; font-size:0.775rem; color:#475569; margin-bottom:0.25rem;">
            <span>提交人: <strong style="color:#1e293b;">${escapeHtml(img.uploader_name || img.uploader_username)}</strong></span>
            ${img.location ? `<span style="color:#0284c7; font-weight:600;">地点: ${escapeHtml(img.location)}</span>` : ''}
          </div>
          ${(img.longitude && img.latitude) ? `
          <div style="display:flex; align-items:center; gap:0.25rem; font-size:0.725rem; color:#059669; font-family:monospace; margin-bottom:0.25rem;">
            <svg class="icon-svg" viewBox="0 0 24 24" style="width:13px; height:13px; color:#16a34a;"><circle cx="12" cy="12" r="9"/><line x1="12" y1="3" x2="12" y2="7"/><line x1="12" y1="17" x2="12" y2="21"/><line x1="3" y1="12" x2="7" y2="12"/><line x1="17" y1="12" x2="21" y2="12"/></svg>
            <span>${parseFloat(img.longitude).toFixed(6)}, ${parseFloat(img.latitude).toFixed(6)}</span>
          </div>` : ''}

          <!-- 底部操作按钮组 -->
          <div style="display:flex; gap:0.4rem; justify-content:flex-end; border-top:1px solid #f1f5f9; padding-top:0.55rem; margin-top:0.4rem;">
            <button class="btn" style="background:#f8fafc; border:1px solid #cbd5e1; color:#334155; font-size:0.75rem; padding:0.3rem 0.55rem; font-weight:600;" data-action="viewGalleryImageLightbox('${escapeJsString(img.id)}')">查看大图</button>
            ${editBtn}
            ${deleteBtn}
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function viewGalleryImageLightbox(imageId) {
  const img = galleryImages.find(i => i.id === imageId);
  if (!img) return;
  const formattedTime = img.timestamp ? new Date(img.timestamp).toLocaleString() : '未知时间';
  openImageLightbox(img.url, {
    description: img.description || '',
    timestamp: formattedTime,
    location: img.location || '',
    uploader: img.uploader_name || img.uploader_username || '',
    longitude: img.longitude,
    latitude: img.latitude
  });
}

function openEditImageModal(imageId) {
  const img = galleryImages.find(i => i.id === imageId);
  if (!img) return;

  document.getElementById('editImgId').value = img.id;
  document.getElementById('editImgDesc').value = img.description || '';
  document.getElementById('editImgLocation').value = img.location || '';
  document.getElementById('editImageModal').style.display = 'flex';
}

function closeEditImageModal() {
  document.getElementById('editImageModal').style.display = 'none';
}

async function handleSaveImageEdit(e) {
  e.preventDefault();
  const id = document.getElementById('editImgId').value;
  const description = document.getElementById('editImgDesc').value.trim();
  const location = document.getElementById('editImgLocation').value.trim();

  try {
    const fetchFn = typeof apiFetch === 'function' ? apiFetch : fetch;
    const res = await fetchFn(`/api/images/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description, location })
    });
    const json = await res.json();

    if (json.success) {
      showToast(json.message);
      closeEditImageModal();
      await loadTaskImagesPage();
    } else {
      showToast(json.error, 'error');
    }
  } catch (err) {
    showToast('修改图片失败: ' + err.message, 'error');
  }
}

async function handleDeleteImage(imageId) {
  if (!confirm('确定要删除该张现场照片吗？此操作不可恢复。')) return;

  try {
    const fetchFn = typeof apiFetch === 'function' ? apiFetch : fetch;
    const res = await fetchFn(`/api/images/${encodeURIComponent(imageId)}`, {
      method: 'DELETE'
    });
    const json = await res.json();

    if (json.success) {
      showToast(json.message);
      await loadTaskImagesPage();
    } else {
      showToast(json.error, 'error');
    }
  } catch (err) {
    showToast('删除图片失败: ' + err.message, 'error');
  }
}

function selectTaskForGallery(taskCode) {
  if (taskCode && typeof taskCode === 'string') {
    localStorage.setItem('vfusion_selected_task_code', taskCode);
  }
  switchTab('tab-task-images');
}

Object.assign(window.VFusionActions = window.VFusionActions || {}, {
  initTaskImagesPage, loadTaskImagesPage, toggleImageSortOrder, renderGalleryGrid,
  viewGalleryImageLightbox, openEditImageModal, closeEditImageModal, handleSaveImageEdit, handleDeleteImage,
  selectTaskForGallery
});
