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

function validateCoordinateInputs() {
  const longitude = (document.querySelector('#dynamicFormGrid [name="longitude"]') || {}).value || '';
  const latitude = (document.querySelector('#dynamicFormGrid [name="latitude"]') || {}).value || '';
  if (!longitude.trim() && !latitude.trim()) return true;
  const longitudeNumber = Number(longitude);
  const latitudeNumber = Number(latitude);
  if (!Number.isFinite(longitudeNumber) || longitudeNumber < -180 || longitudeNumber > 180 ||
      !Number.isFinite(latitudeNumber) || latitudeNumber < -90 || latitudeNumber > 90) {
    showToast('经度范围为 -180 至 180，纬度范围为 -90 至 90，且必须成对填写', 'error');
    return false;
  }
  return true;
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

  // 1. 顶部当前发布任务状态只读提示卡片
  const taskGroup = document.createElement('div');
  taskGroup.className = 'form-group full-width';
  taskGroup.style.cssText = 'background:#f0f9ff; border:1px solid #bae6fd; padding:0.65rem 0.85rem; border-radius:8px; display:flex; align-items:center; justify-content:center;';

  taskGroup.innerHTML = `
    <div style="display:flex; align-items:center; justify-content:center; gap:0.5rem; width:100%; flex-wrap:wrap; text-align:center;">
      <span style="display:inline-flex; align-items:center; gap:0.35rem; color:#0369a1; font-weight:700; font-size:0.875rem;">
        <svg class="icon-svg" viewBox="0 0 24 24" style="color:#0284c7; width:16px; height:16px;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
        当前挂接归属任务：
      </span>
      <span style="font-size:0.9rem; font-weight:700; color:#0f172a; background:#e0f2fe; padding:0.2rem 0.6rem; border-radius:6px; border:1px solid #7dd3fc;">
        ${escapeHtml(taskName)}
      </span>
      <span style="font-size:0.75rem; font-family:monospace; color:#0284c7; background:#ffffff; padding:0.2rem 0.5rem; border-radius:4px; border:1px solid #bae6fd;">
        [${escapeHtml(taskCode)}]
      </span>
      <input type="hidden" name="task_code" value="${escapeHtml(taskCode)}">
      <input type="hidden" name="task_name" value="${escapeHtml(taskName)}">
    </div>
  `;
  grid.appendChild(taskGroup);

  // 2. 涉事人员档案快速下拉选择
  const pGroup = document.createElement('div');
  pGroup.className = 'form-group full-width';
  pGroup.style.cssText = 'background:#f8fafc; border:1px solid #e2e8f0; padding:0.65rem 0.85rem; border-radius:8px; margin-bottom:0.15rem;';

  const optsHtml = registeredPersonnel.map((p, idx) => `
    <option value="${idx}">
      ${escapeHtml(p.name)} | 身份证: ${escapeHtml(p.id_card)} | 户籍: ${escapeHtml(p.domicile || '未记录')}
    </option>
  `).join('');

  pGroup.innerHTML = `
    <label style="color:#334155; font-weight:600; font-size:0.825rem; display:flex; align-items:center; justify-content:space-between; margin-bottom:0.45rem;">
      <span>本任务涉事人员档案 (点击选择一键填入)</span>
      <span style="font-size:0.75rem; font-weight:normal; color:#64748b;">本任务已有 ${registeredPersonnel.length} 人</span>
    </label>
    <select id="personnelSelectBox" style="width:100%; border:1px solid #cbd5e1; background:#ffffff; font-size:0.85rem; font-weight:500; color:#1e293b; padding:0.5rem 0.75rem; border-radius:6px; outline:none; cursor:pointer;" data-action-change="autoFillPersonnel(this.value)">
      <option value="">-- 点击选择已登记人员 (自动关联关联姓名/身份证/户籍) --</option>
      ${optsHtml}
    </select>
    <input type="hidden" name="person_name" value="">
    <input type="hidden" name="person_id_card" value="">
    <input type="hidden" name="person_domicile" value="">
  `;
  grid.appendChild(pGroup);

  // 3. 事发地点与地图坐标拾取卡片
  const locCard = document.createElement('div');
  locCard.className = 'form-group full-width';
  locCard.style.cssText = 'background:#ffffff; border:1px solid #cbd5e1; border-radius:8px; padding:0.75rem; margin-bottom:0.35rem; box-shadow:0 1px 3px rgba(0,0,0,0.03);';
  
  const curLocation = existingValues.location || '';
  const curLng = existingValues.longitude || '';
  const curLat = existingValues.latitude || '';

  locCard.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.55rem;">
      <label style="font-weight:700; color:#1e293b; font-size:0.85rem; margin:0; display:flex; align-items:center; gap:0.4rem;">
        <svg class="icon-svg" viewBox="0 0 24 24" style="color:var(--primary); width:16px; height:16px;"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg>
        事发地点与坐标
      </label>
      <button type="button" class="btn btn-secondary" style="color:var(--primary); font-weight:700; padding:0.3rem 0.75rem; font-size:0.775rem; display:flex; align-items:center; gap:0.35rem;" data-action="openPublishMapPicker()">
        <svg class="icon-svg" viewBox="0 0 24 24" style="width:14px; height:14px;"><circle cx="12" cy="12" r="10"/><polygon points="12 8 8 12 12 16 16 12 12 8"/></svg>
        在地图上选点拾取
      </button>
    </div>
    <div style="display:grid; grid-template-columns: 2fr 1fr 1fr; gap:0.6rem;">
      <div class="form-group" style="margin:0;">
        <label style="font-size:0.75rem; font-weight:600; color:#475569;">事发地点 / 点位说明</label>
        <input id="field-location" type="text" name="location" value="${escapeHtml(curLocation)}" placeholder="如：厂区北门 / 梁溪科技园1号机" autocomplete="off">
      </div>
      <div class="form-group" style="margin:0;">
        <label style="font-size:0.75rem; font-weight:600; color:#475569;">经度 (可选)</label>
        <input id="field-longitude" type="text" name="longitude" value="${escapeHtml(curLng)}" placeholder="如：120.305456" inputmode="decimal" autocomplete="off">
      </div>
      <div class="form-group" style="margin:0;">
        <label style="font-size:0.75rem; font-weight:600; color:#475569;">纬度 (可选)</label>
        <input id="field-latitude" type="text" name="latitude" value="${escapeHtml(curLat)}" placeholder="如：31.570037" inputmode="decimal" autocomplete="off">
      </div>
    </div>
  `;
  grid.appendChild(locCard);

  // 4. 其他表单字段 (排除已有卡片覆盖的字段)
  const excludedKeys = new Set([
    'person_name', 'person_id_card', 'person_domicile',
    'location', 'longitude', 'latitude',
    'monitoring_point_id', 'monitoring_point_name', 'location_source'
  ]);

  (fields || []).forEach(field => {
    if (excludedKeys.has(field.key)) return;

    const group = document.createElement('div');
    const isFullWidth = field.type === 'textarea';
    group.className = 'form-group' + (isFullWidth ? ' full-width' : '');

    const curVal = existingValues[field.key] !== undefined ? existingValues[field.key] : (field.key === 'event_time' ? nowStr : '');

    const safeKey = escapeHtml(field.key);
    const safeLabel = escapeHtml(field.label);
    const safeVal = escapeHtml(curVal);

    let inputHtml = '';
    if (field.type === 'select') {
      const opts = (field.options || []).map(opt => `<option value="${escapeHtml(opt)}" ${curVal === opt ? 'selected' : ''}>${escapeHtml(opt)}</option>`).join('');
      inputHtml = `<select name="${safeKey}" ${field.required ? 'required' : ''}>${opts}</select>`;
    } else if (field.type === 'radio') {
      const opts = (field.options || []).map((opt, idx) => `
        <label class="radio-label">
          <input type="radio" name="${safeKey}" value="${escapeHtml(opt)}" ${curVal ? (curVal === opt ? 'checked' : '') : (idx === 0 ? 'checked' : '')}>
          ${escapeHtml(opt)}
        </label>
      `).join('');
      inputHtml = `<div class="radio-group">${opts}</div>`;
    } else if (field.type === 'textarea') {
      inputHtml = `<textarea name="${safeKey}" placeholder="请输入${safeLabel}" style="height:60px; min-height:54px;" ${field.required ? 'required' : ''}>${safeVal}</textarea>`;
    } else {
      inputHtml = `<input id="field-${safeKey}" type="text" name="${safeKey}" value="${safeVal}" placeholder="请输入${safeLabel}" autocomplete="off" ${field.required ? 'required' : ''}>`;
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
    selectedFiles = [newFiles[0]];
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

  const file = selectedFiles[0];
  const imgUrl = URL.createObjectURL(file);

  promptEl.style.display = 'none';
  previewEl.style.display = 'flex';
  previewEl.style.flexDirection = 'column';
  previewEl.style.width = '100%';
  previewEl.style.height = '100%';
  previewEl.style.minHeight = '280px';

  if (uploadZone) {
    uploadZone.style.padding = '0';
    uploadZone.style.background = '#0f172a';
    uploadZone.style.borderColor = '#3b82f6';
  }

  previewEl.innerHTML = `
    <div style="display:flex; flex-direction:column; width:100%; height:100%; min-height:280px; position:relative; background:#0f172a; border-radius:10px; overflow:hidden;">
      <div style="flex:1; display:flex; align-items:center; justify-content:center; padding:0.75rem; position:relative; min-height:220px; overflow:hidden;" data-action="event.stopPropagation(); openImageLightbox('${imgUrl}', '抓拍照片预览: ${escapeHtml(file.name)}')">
        <img src="${imgUrl}" style="max-width:100%; max-height:250px; width:auto; height:auto; object-fit:contain; border-radius:8px; box-shadow:0 10px 25px rgba(0,0,0,0.5); cursor:pointer;" title="点击放大预览: ${escapeHtml(file.name)}">
        <div style="position:absolute; top:10px; right:10px; background:rgba(0,0,0,0.65); backdrop-filter:blur(4px); color:#fff; font-size:0.725rem; padding:3px 8px; border-radius:12px; border:1px solid rgba(255,255,255,0.2); pointer-events:none; display:flex; align-items:center; gap:0.25rem;">
          <svg viewBox="0 0 24 24" style="width:12px; height:12px; fill:none; stroke:currentColor; stroke-width:2;"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg> 点击放大预览
        </div>
      </div>
      <div style="background:rgba(15,23,42,0.92); backdrop-filter:blur(4px); padding:0.6rem 0.85rem; border-top:1px solid rgba(255,255,255,0.1); display:flex; justify-content:space-between; align-items:center; color:#fff; font-size:0.8rem; z-index:10;" data-action="event.stopPropagation()">
        <div style="display:flex; align-items:center; gap:0.5rem; overflow:hidden;">
          <span style="color:#94a3b8;">已选抓拍照片:</span>
          <strong style="color:#60a5fa; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:180px;" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</strong>
          <span style="color:#cbd5e1; font-size:0.75rem; font-family:monospace; background:rgba(255,255,255,0.1); padding:1px 6px; border-radius:4px;">${(file.size / 1024).toFixed(0)}KB</span>
        </div>
        <div style="display:flex; gap:0.4rem; flex-shrink:0;">
          <button type="button" class="btn" style="padding:0.25rem 0.65rem; font-size:0.75rem; background:#2563eb; color:#fff; border:none; border-radius:4px; cursor:pointer;" data-action="document.getElementById('photoInput').click()">重新选择</button>
          <button type="button" class="btn btn-danger" style="padding:0.25rem 0.65rem; font-size:0.75rem;" data-action="clearAllSelectedFiles()">清空图片</button>
        </div>
      </div>
    </div>
  `;
}

function clearAllSelectedFiles() {
  selectedFiles = [];
  const photoInput = document.getElementById('photoInput');
  if (photoInput) photoInput.value = '';
  renderFilePreviews();
}

function removeSelectedFile() {
  clearAllSelectedFiles();
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

function bindPublishFormSubmit() {
  const form = document.getElementById('publishForm');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (selectedFiles.length === 0) { showToast('请至少上传一张抓拍照片！', 'error'); return; }
    if (!validateCoordinateInputs()) return;

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
      formData.append('operator', formatUserWithRealName(currentUser.username, currentUser.name));
      formData.append('operator_username', currentUser.username);
      formData.append('operator_name', currentUser.name);
    } else {
      formData.append('operator', 'operator (视频网操作员)');
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

function openPublishMapPicker() {
  const lngInput = document.querySelector('#dynamicFormGrid [name="longitude"]');
  const latInput = document.querySelector('#dynamicFormGrid [name="latitude"]');
  const locInput = document.querySelector('#dynamicFormGrid [name="location"]');

  const currentLng = lngInput?.value.trim() || '';
  const currentLat = latInput?.value.trim() || '';

  if (typeof window.openMapPicker === 'function') {
    window.openMapPicker({
      initialLng: currentLng ? parseFloat(currentLng) : null,
      initialLat: currentLat ? parseFloat(currentLat) : null,
      title: '高德离线地图选点拾取坐标',
      onConfirm: (lng, lat) => {
        if (lngInput) lngInput.value = lng;
        if (latInput) latInput.value = lat;
        if (locInput && !locInput.value.trim()) {
          locInput.value = `现场点位 (${lng}, ${lat})`;
        }
        showToast(`已从地图拾取坐标: ${lng}, ${lat}`);
      }
    });
  } else {
    showToast('地图选点组件初始化中，请稍候...', 'warn');
  }
}

Object.assign(window.VFusionActions = window.VFusionActions || {}, {
  handleFileSelect, autoFillPersonnel, loadPersonnelList, loadTaskOptions,
  selectTaskForPublish, publishToTask, clearAllSelectedFiles, removeSelectedFile,
  openPublishMapPicker
});
