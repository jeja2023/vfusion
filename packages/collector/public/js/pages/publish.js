let selectedFiles = [];
let registeredPersonnel = [];

async function loadPersonnelList() {
  try {
    const res = await fetch('/api/personnel');
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
    group.className = 'form-group' + (field.type === 'textarea' ? ' full-width' : '');

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
      inputHtml = `<textarea name="${safeKey}" placeholder="请输入${safeLabel}" ${field.required ? 'required' : ''}>${safeVal}</textarea>`;
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
  selectedFiles = Array.from(e.target.files);
  renderFilePreviews();
}

function renderFilePreviews() {
  const container = document.getElementById('previewContainer');
  if (!container) return;
  container.innerHTML = '';

  selectedFiles.forEach((file, idx) => {
    const wrapper = document.createElement('div');
    wrapper.className = 'preview-wrapper';
    wrapper.innerHTML = `
      <img class="preview-thumb" src="${URL.createObjectURL(file)}">
      <button type="button" class="preview-delete-btn" onclick="removeSelectedFile(${idx})">✕</button>
    `;
    container.appendChild(wrapper);
  });
}

function removeSelectedFile(idx) {
  selectedFiles.splice(idx, 1);
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
      const res = await fetch('/api/publish', { method: 'POST', body: formData });
      const result = await res.json();

      if (result.success) {
        showToast('数据摆渡包已成功生成并自动投递！');
        const logCard = document.getElementById('logCard');
        const logCode = document.getElementById('logCode');
        if (logCard) logCard.style.display = 'block';
        if (logCode) logCode.innerText = JSON.stringify(result.data, null, 2);
        if (logCard) logCard.scrollIntoView({ behavior: 'smooth' });

        e.target.reset();
        const previewCont = document.getElementById('previewContainer');
        if (previewCont) previewCont.innerHTML = '';
        selectedFiles = [];

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
