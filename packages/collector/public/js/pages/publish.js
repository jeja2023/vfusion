let selectedFiles = [];
let registeredPersonnel = [];

async function loadPersonnelList(taskCode) {
  try {
    const fetchFn = typeof apiFetch === 'function' ? apiFetch : fetch;
    const code = taskCode || selectedTaskCode || localStorage.getItem('vfusion_selected_task_code') || '';
    const url = code ? `/api/personnel?task_code=${encodeURIComponent(code)}` : '/api/personnel';
    const res = await fetchFn(url);
    const json = await res.json();
    if (json.success) registeredPersonnel = json.data || [];
  } catch (e) {}
}

function autoFillPersonnel(valIdx) {
  if (valIdx === '') return;
  const idx = parseInt(valIdx);
  const person = registeredPersonnel[idx];
  if (!person) return;

  const nameInput = document.querySelector('input[name="person_name"]');
  const idInput = document.querySelector('input[name="person_id_card"]');
  const domicileInput = document.querySelector('input[name="person_domicile"]');

  if (nameInput) nameInput.value = person.name || '';
  if (idInput) idInput.value = person.id_card || '';
  if (domicileInput) domicileInput.value = person.domicile || '';

  showToast(`已提取并填入人员: ${person.name} (${person.id_card})`);
}

let availableTasks = [];
let selectedTaskCode = '';

async function loadTaskOptions() {
  try {
    const fetchFn = typeof apiFetch === 'function' ? apiFetch : fetch;
    const res = await fetchFn('/api/tasks');
    const json = await res.json();
    if (json.success) {
      availableTasks = (json.data || []).filter(t => t.status === 'ACTIVE' || t.is_shared);
      const storedCode = selectedTaskCode || localStorage.getItem('vfusion_selected_task_code') || '';
      if (storedCode && availableTasks.some(t => t.task_code === storedCode)) {
        selectedTaskCode = storedCode;
      } else if (availableTasks.length > 0) {
        selectedTaskCode = availableTasks[0].task_code;
      }
      await loadPersonnelList(selectedTaskCode);
    }
  } catch (e) {
    console.error('加载任务数据失败:', e);
  }
}

function selectTaskForPublish(taskCode) {
  selectedTaskCode = taskCode;
  localStorage.setItem('vfusion_selected_task_code', taskCode);
  loadPersonnelList(taskCode);
}

function publishToTask(taskCode) {
  selectTaskForPublish(taskCode);
  if (typeof switchTab === 'function') switchTab('tab-publish');
}

function renderDynamicForm(fields) {
  const grid = document.getElementById('dynamicFormGrid');
  if (!grid) return;

  const existingValues = {};
  grid.querySelectorAll('input, select, textarea').forEach(el => {
    if (el.name && el.value) existingValues[el.name] = el.value;
  });

  grid.innerHTML = '';

  const nowStr = new Date().toISOString().replace('T', ' ').slice(0, 19);

  const storedCode = selectedTaskCode || localStorage.getItem('vfusion_selected_task_code') || '';
  const currentTask = availableTasks.find(t => t.task_code === storedCode) || (availableTasks.length > 0 ? availableTasks[0] : null);

  const taskName = currentTask ? currentTask.task_name : '未指定任务';
  const taskCode = currentTask ? currentTask.task_code : (storedCode || '');

  // 顶部当前发布任务状态只读提示卡片 (不含切换按钮，需通过任务中心进行任务切换)
  const taskGroup = document.createElement('div');
  taskGroup.className = 'form-group full-width';
  taskGroup.style.cssText = 'background:#f0f9ff; border:1px solid #bae6fd; padding:0.65rem 0.85rem; border-radius:8px; display:flex; align-items:center; justify-content:center;';

  taskGroup.innerHTML = `
    <div style="display:flex; align-items:center; gap:0.5rem; flex-wrap:wrap; justify-content:center;">
      <span style="font-size:0.8rem; color:#0369a1; font-weight:600;">当前发布任务:</span>
      <strong style="font-size:0.9rem; color:#0284c7;">${escapeHtml(taskName)}</strong>
      <code style="font-size:0.775rem; color:#0284c7; font-weight:600;">(${escapeHtml(taskCode)})</code>
    </div>
    <input type="hidden" name="task_name" value="${escapeHtml(taskName)}">
    <input type="hidden" name="task_code" value="${escapeHtml(taskCode)}">
  `;
  grid.appendChild(taskGroup);

  // 美化后的本任务涉事人员档案下拉组
  const pGroup = document.createElement('div');
  pGroup.className = 'form-group full-width';
  pGroup.style.cssText = 'background:#ffffff; border:1px solid #e2e8f0; padding:0.75rem 0.9rem; border-radius:8px; box-shadow:0 1px 2px rgba(0,0,0,0.03);';

  const optsHtml = registeredPersonnel.length > 0
    ? registeredPersonnel.map((p, idx) => `<option value="${idx}">${escapeHtml(p.name)} - 身份证: ${escapeHtml(p.id_card) || '未填'} (户籍: ${escapeHtml(p.domicile) || '未填'})</option>`).join('')
    : '<option value="" disabled>-- 本任务暂无关联登记人员 (输入姓名身份证提交后将自动关联本任务) --</option>';

  pGroup.innerHTML = `
    <label style="color:#334155; font-weight:600; font-size:0.825rem; display:flex; align-items:center; justify-content:space-between; margin-bottom:0.45rem;">
      <span>本任务涉事人员档案 (点击选择一键填入)</span>
      <span style="font-size:0.75rem; font-weight:normal; color:#64748b;">本任务已有 ${registeredPersonnel.length} 人</span>
    </label>
    <select id="personnelSelectBox" style="width:100%; border:1px solid #cbd5e1; background:#ffffff; font-size:0.85rem; font-weight:500; color:#1e293b; padding:0.5rem 0.75rem; border-radius:6px; outline:none; cursor:pointer;" onchange="autoFillPersonnel(this.value)">
      <option value="">-- 点击选择已登记人员 (自动关联关联姓名/身份证/户籍) --</option>
      ${optsHtml}
    </select>
    <input type="hidden" name="person_name" value="">
    <input type="hidden" name="person_id_card" value="">
    <input type="hidden" name="person_domicile" value="">
  `;
  grid.appendChild(pGroup);

  (fields || []).forEach(field => {
    if (['person_name', 'person_id_card', 'person_domicile'].includes(field.key)) return;

    const group = document.createElement('div');
    const isFullWidth = field.type === 'textarea' || field.key === 'location';
    group.className = 'form-group' + (isFullWidth ? ' full-width' : '');

    const curVal = existingValues[field.key] !== undefined ? existingValues[field.key] : (field.key === 'event_time' ? nowStr : '');

    const safeKey = escapeHtml(field.key);
    const safeLabel = escapeHtml(field.label);
    const safeVal = escapeHtml(curVal);

    let inputHtml = '';
    if (field.type === 'select') {
      const optsHtml = (field.options || []).map(opt => `<option value="${escapeHtml(opt)}" ${curVal === opt ? 'selected' : ''}>${escapeHtml(opt)}</option>`).join('');
      inputHtml = `<select name="${safeKey}" ${field.required ? 'required' : ''}>${optsHtml}</select>`;
    } else if (field.type === 'radio') {
      const optsHtml = (field.options || []).map((opt, idx) => `
        <label class="radio-label">
          <input type="radio" name="${safeKey}" value="${escapeHtml(opt)}" ${curVal ? (curVal === opt ? 'checked' : '') : (idx === 0 ? 'checked' : '')}>
          ${escapeHtml(opt)}
        </label>
      `).join('');
      inputHtml = `<div class="radio-group">${optsHtml}</div>`;
    } else if (field.type === 'textarea') {
      inputHtml = `<textarea name="${safeKey}" placeholder="请输入${safeLabel}" style="height:60px; min-height:54px;" ${field.required ? 'required' : ''}>${safeVal}</textarea>`;
    } else {
      inputHtml = `<input type="text" name="${safeKey}" value="${safeVal}" placeholder="请输入${safeLabel}" ${field.required ? 'required' : ''}>`;
    }

    group.innerHTML = `
      <label>${safeLabel} ${field.required ? '<span class="req">*</span>' : ''}</label>
      ${inputHtml}
    `;
    grid.appendChild(group);
  });

  loadTaskOptions();
}

function handleFileSelect(e) {
  const newFiles = Array.from(e.target.files);
  if (newFiles.length > 0) {
    selectedFiles = selectedFiles.concat(newFiles);
  }
  renderFilePreviews();
}

function renderFilePreviews() {
  const promptEl = document.getElementById('uploadPrompt');
  const previewEl = document.getElementById('uploadPreviewContent');
  const uploadZone = document.getElementById('uploadZone');
  if (!promptEl || !previewEl) return;

  initUploadZoneDragAndDrop();

  if (selectedFiles.length === 0) {
    promptEl.style.display = 'block';
    previewEl.style.display = 'none';
    previewEl.innerHTML = '';
    if (uploadZone) {
      uploadZone.style.padding = '1.25rem';
      uploadZone.style.background = '#f8fafc';
      uploadZone.style.borderColor = '#93c5fd';
    }
    return;
  }

  promptEl.style.display = 'none';
  previewEl.style.display = 'flex';
  previewEl.style.flexDirection = 'column';
  previewEl.style.width = '100%';
  previewEl.style.height = '100%';
  if (uploadZone) {
    uploadZone.style.padding = '0.5rem';
    uploadZone.style.background = '#0f172a';
    uploadZone.style.borderColor = '#3b82f6';
  }

  const fileThumbnails = selectedFiles.map((file, idx) => {
    const imgUrl = URL.createObjectURL(file);
    return `
      <div style="position:relative; width:90px; height:90px; border-radius:8px; overflow:hidden; border:1px solid rgba(255,255,255,0.2); background:#1e293b; flex-shrink:0;">
        <img src="${imgUrl}" style="width:100%; height:100%; object-fit:cover; cursor:pointer;" onclick="event.stopPropagation(); if(typeof openImageLightbox === 'function') openImageLightbox('${imgUrl}', '图片预览: ${escapeHtml(file.name)}')" title="${escapeHtml(file.name)}">
        <button type="button" style="position:absolute; top:2px; right:2px; width:20px; height:20px; border-radius:50%; background:#ef4444; color:#fff; border:none; font-size:0.75rem; font-weight:bold; cursor:pointer; display:flex; align-items:center; justify-content:center;" onclick="event.stopPropagation(); removeSelectedFile(${idx})">✕</button>
        <div style="position:absolute; bottom:0; inset-x:0; background:rgba(0,0,0,0.6); color:#fff; font-size:0.65rem; padding:1px 3px; text-align:center; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${(file.size / 1024).toFixed(0)}KB</div>
      </div>
    `;
  }).join('');

  previewEl.innerHTML = `
    <div style="display:flex; flex-direction:column; width:100%; height:100%; justify-content:space-between;">
      <div style="display:flex; flex-wrap:wrap; gap:0.6rem; padding:0.5rem; max-height:220px; overflow-y:auto;">
        ${fileThumbnails}
        <div style="width:90px; height:90px; border-radius:8px; border:2px dashed rgba(255,255,255,0.4); display:flex; flex-direction:column; align-items:center; justify-content:center; color:#bfdbfe; cursor:pointer; background:rgba(255,255,255,0.05);" onclick="document.getElementById('photoInput').click()">
          <span style="font-size:1.4rem; font-weight:bold;">+</span>
          <span style="font-size:0.7rem;">加图</span>
        </div>
      </div>
      <div style="background:rgba(15,23,42,0.9); padding:0.5rem 0.8rem; border-radius:6px; display:flex; justify-content:space-between; align-items:center; color:#fff; font-size:0.8rem;">
        <span>已选择 <strong style="color:#60a5fa;">${selectedFiles.length}</strong> 张现场照片</span>
        <button type="button" class="btn btn-danger" style="padding:0.2rem 0.5rem; font-size:0.75rem;" onclick="clearAllSelectedFiles()">清空图片</button>
      </div>
    </div>
  `;
}

function removeSelectedFile(idx) {
  selectedFiles.splice(idx, 1);
  renderFilePreviews();
}

function clearAllSelectedFiles() {
  selectedFiles = [];
  const photoInput = document.getElementById('photoInput');
  if (photoInput) photoInput.value = '';
  renderFilePreviews();
}

function initUploadZoneDragAndDrop() {
  const uploadZone = document.getElementById('uploadZone');
  if (!uploadZone || uploadZone.dataset.dragInit) return;
  uploadZone.dataset.dragInit = 'true';

  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
    uploadZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
    }, false);
  });

  ['dragenter', 'dragover'].forEach(eventName => {
    uploadZone.addEventListener(eventName, () => {
      uploadZone.classList.add('drag-over');
    }, false);
  });

  ['dragleave', 'drop'].forEach(eventName => {
    uploadZone.addEventListener(eventName, () => {
      uploadZone.classList.remove('drag-over');
    }, false);
  });

  uploadZone.addEventListener('drop', (e) => {
    const dt = e.dataTransfer;
    const files = dt ? dt.files : null;
    if (files && files.length > 0) {
      const imageFiles = Array.from(files).filter(f => f.type.startsWith('image/'));
      if (imageFiles.length > 0) {
        selectedFiles = [imageFiles[0]];
        renderFilePreviews();
      } else {
        if (typeof showToast === 'function') showToast('请上传有效的图片文件！', 'error');
      }
    }
  }, false);
}

function removeSelectedFile(idx) {
  selectedFiles = [];
  const photoInput = document.getElementById('photoInput');
  if (photoInput) photoInput.value = '';
  renderFilePreviews();
}

function bindPublishFormSubmit() {
  const form = document.getElementById('publishForm');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (selectedFiles.length === 0) { showToast('请至少上传一张抓拍照片！', 'error'); return; }

    const btn = document.getElementById('btnSubmit');
    btn.disabled = true;
    btn.innerHTML = '正在计算摘要校验与数字签名并封装数据包...';

    const formData = new FormData(e.target);
    formData.delete('images');
    selectedFiles.forEach(f => formData.append('images', f));

    const appId = 'sys_gate_security';
    formData.append('app_id', appId);
    formData.append('event_id', 'EVT_' + Date.now());

    if (currentUser) {
      formData.append('operator', `${currentUser.name} (${currentUser.username})`);
      formData.append('operator_username', currentUser.username);
      formData.append('operator_name', currentUser.name);
    } else {
      formData.append('operator', '视频网操作员 (operator)');
      formData.append('operator_username', 'operator');
      formData.append('operator_name', '视频网操作员');
    }
    formData.append('submit_time', new Date().toISOString());

    try {
      const fetchFn = typeof apiFetch === 'function' ? apiFetch : fetch;
      const res = await fetchFn('/api/publish', { method: 'POST', body: formData });
      const result = await res.json();

      if (result.success) {
        showToast('打包成功！已完成原子重命名并存入发送目录');

        const submittedTaskCode = formData.get('task_code');
        if (submittedTaskCode) {
          localStorage.setItem('vfusion_selected_task_code', submittedTaskCode);
          if (typeof selectedTaskCode !== 'undefined') selectedTaskCode = submittedTaskCode;
        }

        e.target.reset();
        selectedFiles = [];
        renderFilePreviews();

        await loadPersonnelList();
        if (typeof currentSchema !== 'undefined' && currentSchema.fields) {
          renderDynamicForm(currentSchema.fields);
        }
      } else { showToast('打包失败: ' + result.error, 'error'); }
    } catch (err) { showToast('提交异常: ' + err.message, 'error'); }
    finally {
      btn.disabled = false;
      btn.innerHTML = `
        <svg class="icon-svg" viewBox="0 0 24 24"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
        确认提交并生成数据摆渡包
      `;
    }
  });
}
