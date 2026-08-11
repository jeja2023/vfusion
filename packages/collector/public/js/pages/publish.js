let selectedFiles = [];
let registeredPersonnel = [];

async function loadPersonnelList() {
  try {
    const fetchFn = typeof apiFetch === 'function' ? apiFetch : fetch;
    const res = await fetchFn('/api/personnel');
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

function renderDynamicForm(fields) {
  const grid = document.getElementById('dynamicFormGrid');
  if (!grid) return;

  const existingValues = {};
  grid.querySelectorAll('input, select, textarea').forEach(el => {
    if (el.name && el.value) existingValues[el.name] = el.value;
  });

  grid.innerHTML = '';

  const nowStr = new Date().toISOString().replace('T', ' ').slice(0, 19);

  const taskGroup = document.createElement('div');
  taskGroup.className = 'form-group full-width';
  taskGroup.style.cssText = 'background:#f8fafc; border:1px solid var(--border-color); padding:0.5rem 0.75rem; border-radius:8px; display:grid; grid-template-columns: 1.1fr 0.9fr; gap:0.65rem;';
  
  const defaultTaskCode = 'TASK_' + new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 12);
  const savedTaskName = escapeHtml(existingValues['task_name'] || '厂区周界安防例行巡检');
  const savedTaskCode = escapeHtml(existingValues['task_code'] || defaultTaskCode);

  taskGroup.innerHTML = `
    <div>
      <label style="color:var(--text-main); font-weight:700; font-size:0.8rem; display:flex; align-items:center; gap:0.35rem;">
        <svg class="icon-svg" viewBox="0 0 24 24" style="color:var(--primary);"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
        所属任务名称 <span class="req">*</span>
      </label>
      <input type="text" name="task_name" required placeholder="如: 厂区周界巡检 / 北门安全排查" value="${savedTaskName}" style="width:100%; margin-top:0.15rem;">
    </div>
    <div>
      <label style="color:var(--text-main); font-weight:700; font-size:0.8rem; display:flex; align-items:center; gap:0.35rem;">
        <svg class="icon-svg" viewBox="0 0 24 24" style="color:var(--primary);"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
        关联任务编号 <span class="req">*</span>
      </label>
      <input type="text" name="task_code" required placeholder="任务唯一代号 (如: TASK_20260811_01)" value="${savedTaskCode}" style="width:100%; margin-top:0.15rem; font-family:monospace; color:var(--primary); font-weight:600;">
    </div>
  `;
  grid.appendChild(taskGroup);

  const pGroup = document.createElement('div');
  pGroup.className = 'form-group full-width';
  pGroup.style.cssText = 'background:#eff6ff; border:1.5px dashed #3b82f6; padding:0.5rem 0.75rem; border-radius:8px;';
  
  const optsHtml = registeredPersonnel.length > 0
    ? registeredPersonnel.map((p, idx) => `<option value="${idx}">${escapeHtml(p.name)} - 身份证: ${escapeHtml(p.id_card) || '未填'} (户籍: ${escapeHtml(p.domicile) || '未填'})</option>`).join('')
    : '<option value="" disabled>暂无历史人员档案 (首次录入提交后将自动存档)</option>';

  pGroup.innerHTML = `
    <label style="color:#1d4ed8; font-weight:700; font-size:0.875rem; display:flex; align-items:center; justify-content:space-between;">
      <span style="display:flex; align-items:center; gap:0.45rem;">
        <svg class="icon-svg" viewBox="0 0 24 24" style="color:#2563eb;"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 1 0 7.75"/></svg>
        涉事人员历史档案 (点击选择一键填入)
      </span>
      <span style="font-size:0.75rem; font-weight:normal; color:#2563eb;">已有 ${registeredPersonnel.length} 人档案</span>
    </label>
    <select id="personnelSelectBox" style="border:1px solid #93c5fd; background:#ffffff; font-weight:600; cursor:pointer;" onchange="autoFillPersonnel(this.value)">
      <option value="">-- 点击下拉框选择已登记人员 (自动填入姓名/身份证/户籍) --</option>
      ${optsHtml}
    </select>
  `;
  grid.appendChild(pGroup);

  (fields || []).forEach(field => {
    const group = document.createElement('div');
    const isFullWidth = field.type === 'textarea' || field.key === 'location' || field.key === 'person_domicile';
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
}

function handleFileSelect(e) {
  selectedFiles = Array.from(e.target.files).slice(0, 1);
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
  previewEl.style.width = '100%';
  previewEl.style.height = '100%';
  if (uploadZone) {
    uploadZone.style.padding = '0';
    uploadZone.style.background = '#0f172a';
    uploadZone.style.borderColor = '#3b82f6';
  }

  previewEl.innerHTML = `
    <div style="position:relative; width:100%; height:100%; min-height:280px; display:flex; align-items:center; justify-content:center; overflow:hidden; background:#0f172a; border-radius:10px;">
      <!-- 毛玻璃背景 Layer -->
      <div style="position:absolute; inset:0; background-image:url('${imgUrl}'); background-size:cover; background-position:center; filter:blur(20px) brightness(0.45); transform:scale(1.1); pointer-events:none;"></div>
      
      <!-- 主图：自动等比缩放适配容器 (object-fit: contain) -->
      <img src="${imgUrl}" 
           title="点击放大预览" 
           style="position:relative; z-index:1; max-width:96%; max-height:calc(100% - 56px); width:auto; height:auto; object-fit:contain; border-radius:8px; box-shadow:0 8px 24px rgba(0,0,0,0.5); cursor:pointer; transition:transform 0.2s ease;" 
           onmouseover="this.style.transform='scale(1.02)'" 
           onmouseout="this.style.transform='scale(1.0)'" 
           onclick="event.stopPropagation(); if(typeof openImageLightbox === 'function') openImageLightbox('${imgUrl}', '现场凭证抓拍大图: ${escapeHtml(file.name)}')">
      
      <!-- 底部浮层信息栏 -->
      <div style="position:absolute; bottom:0; left:0; right:0; z-index:2; background:linear-gradient(to top, rgba(15,23,42,0.95) 0%, rgba(15,23,42,0.7) 75%, transparent 100%); backdrop-filter:blur(8px); padding:0.6rem 0.9rem; border-radius:0 0 10px 10px; display:flex; justify-content:space-between; align-items:center; color:#ffffff;">
        <div style="display:flex; flex-direction:column; text-align:left; overflow:hidden; padding-right:0.5rem;">
          <span style="font-size:0.85rem; font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span>
          <span style="font-size:0.725rem; color:#cbd5e1; font-weight:500;">${(file.size / 1024).toFixed(1)} KB · 自动等比缩放适配就绪</span>
        </div>
        <div style="display:flex; gap:0.4rem; flex-shrink:0;">
          <button type="button" class="btn" style="padding:0.3rem 0.6rem; font-size:0.75rem; white-space:nowrap; background:rgba(255,255,255,0.15); border:1px solid rgba(255,255,255,0.25); color:#fff; cursor:pointer;" onclick="event.stopPropagation(); if(typeof openImageLightbox === 'function') openImageLightbox('${imgUrl}', '现场凭证抓拍大图: ${escapeHtml(file.name)}')">
            🔍 放大
          </button>
          <button type="button" class="btn btn-danger" style="padding:0.3rem 0.75rem; font-size:0.75rem; white-space:nowrap; cursor:pointer; box-shadow:0 2px 6px rgba(0,0,0,0.3);" onclick="event.stopPropagation(); removeSelectedFile(0)">
            更换照片
          </button>
        </div>
      </div>
    </div>
  `;
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
        if (typeof showToast === 'function') showToast('请上传有效的图片凭证文件！', 'error');
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
        showToast(result.message || '数据摆渡包已成功生成！');
        const logCard = document.getElementById('logCard');
        const logCode = document.getElementById('logCode');
        if (logCard) logCard.style.display = 'block';
        if (logCode) logCode.innerText = JSON.stringify(result.data, null, 2);
        if (logCard) logCard.scrollIntoView({ behavior: 'smooth' });

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
