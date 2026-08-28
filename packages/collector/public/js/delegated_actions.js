(function installDelegatedActions(global) {
  const actionNames = new Set();
  const register = name => actionNames.add(name);
  const knownFunctions = [
    'handleLogin','closeDrawer','handleLogout','toggleAlertDropdown','markAlertsRead','exportCsvReport','switchTab',
    'openImageLightbox','closeImageLightbox','showPersonDetailModal','closePersonDetailModal','openAddWebhookModal',
    'loadWebhooks','changeWebhookPageSize','prevWebhookPage','nextWebhookPage','closeAddWebhookModal','handleAddWebhookSubmit',
    'closeEditWebhookModal','handleSaveWebhook','toggleWebhookNode','openEditWebhookModal','testWebhook','deleteWebhook','rotateWebhookSecret',
    'openAddUserModal','closeAddUserModal','handleCreateUserSubmit','closeEditUserModal','handleSaveUser','resetUserPassword','deleteUser','changeUsersPageSize','prevUsersPage','nextUsersPage',
    'loadFullAuditLogs','changeAuditPageSize','prevAuditPage','nextAuditPage','exportAuditLogsCsv','loadErrors','changeErrorPageSize',
    'prevErrorPage','nextErrorPage','retryError','deleteError','loadPersonnelArchive','changePersonnelPageSize','prevPersonnelPage',
    'nextPersonnelPage','openAddPersonnelModal','closeAddPersonnelModal','handleAddPersonnelSubmit','closeEditPersonnelModal',
    'handleSavePersonnel','editPersonnel','deletePersonnel','openAddFtpModal','loadFtpServersList','manualFtpPullAll',
    'saveFtpPollInterval','onFtpPollToggleChange','closeAddFtpModal','handleAddFtpServerSubmit','testNewFtpNodeForm',
    'closeEditFtpModal','handleSaveFtpServer','toggleFtpNode','testFtpNode','manualFtpPullNode','deleteFtpNode','openEditFtpModal','loadSystemHealth',
    'loadCoreMonitoringPointTable','scheduleCoreMonitoringPointSearch','exportCoreMonitoringPoints','importCoreMonitoringPoints',
    'resetCoreMonitoringPointForm','editCoreMonitoringPoint','saveCoreMonitoringPoint','toggleCoreMonitoringPoint','rotateHmacSecret',
    'saveFtpChannelConfig','testFtpServerConnection','uploadWebPatchUpgrade','onUpgradeFileSelected','viewCorePhotoLightbox',
    'switchCoreView','changeTaskPageSize','prevTaskPage','nextTaskPage','openTaskDetailDrawer','openEventDrawer','renderCoreDashboard','changeEvtPageSize','prevEvtPage',
    'nextEvtPage','coreEditImage','coreDeleteImage','toggleImageSortOrder','loadTaskImagesPage','renderGalleryGrid','openEditImageModal','closeEditImageModal',
    'handleDeleteImage','handleSaveImageEdit','publishToTask','selectTaskForGallery','openTaskDetailModal','openEditTaskModal','closeEditTaskModal',
    'handleDeleteTask','openTaskPersonnelModal','closeTaskPersonnelModal','closeShareTaskModal','changeTpPageSize','prevTpPage','nextTpPage','handleSaveTaskEdit',
    'handleAddTaskPersonnel','handleSaveTaskShare','closeTaskDetailModal','openShareTaskModal','loadPublishedHistory',
    'renderPublishedHistory','changeHistoryPageSize','prevHistoryPage','nextHistoryPage','renderTaskCards','openCreateTaskModal','closeCreateTaskModal',
    'handleCreateTask','openJoinTaskModal','closeJoinTaskModal','handleJoinTask','openNewMonitoringPointForm',
    'clearMonitoringPointSelection','saveNewMonitoringPoint','closeNewMonitoringPointForm','chooseMonitoringPoint',
    'autoFillPersonnel','scheduleMonitoringPointSearch','searchMonitoringPoints','clearAllSelectedFiles','openAddFieldModal',
    'exportSchemaJson','saveSchemaConfig','changeSchemaPageSize','prevSchemaPage','nextSchemaPage','closeAddFieldModal',
    'handleAddFieldSubmit','openEditFieldModal','removeSchemaField','closeEditFieldModal','handleSaveField','openAddCollectorFtpModal',
    'loadCollectorFtpServersList','closeAddCollectorFtpModal','handleAddCollectorFtpSubmit','testNewCollectorFtpNodeForm','openEditCollectorFtpModal','deleteCollectorFtpNode',
    'closeEditCollectorFtpModal','handleSaveCollectorFtpServer','toggleCollectorFtpNode','testCollectorFtpNode',
    'openAddUserModal','openEditUserModal','loadCollectorSystemConfig','loadMonitoringPointAdminTable','scheduleMonitoringPointAdminSearch',
    'exportMonitoringPoints','importMonitoringPoints','resetMonitoringPointForm','editMonitoringPoint','saveMonitoringPoint',
    'toggleMonitoringPoint','saveCollectorHmacSecret','uploadCollectorWebPatchUpgrade','selectTaskForPublish','handleFileSelect',
    'viewGalleryImageLightbox','handleDeleteTaskPersonnel','openShareTaskModal','openTaskPersonnelModal'
  ];
  knownFunctions.forEach(register);

  function decode(value) {
    return String(value || '');
  }
  function splitArgs(source) {
    const args = [];
    let start = 0, depth = 0, quote = null;
    for (let i = 0; i < source.length; i++) {
      const ch = source[i];
      if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = null; continue; }
      if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
      if ('([{'.includes(ch)) depth++;
      else if (')]}'.includes(ch)) depth--;
      else if (ch === ',' && depth === 0) { args.push(source.slice(start, i).trim()); start = i + 1; }
    }
    if (source.slice(start).trim() || source.trim() === '') args.push(source.slice(start).trim());
    return args;
  }
  function resolveValue(raw, event, element) {
    const value = decode(raw).trim();
    if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) return value.slice(1, -1).replace(/\\(['"\\])/g, '$1');
    if (value === 'event') return event;
    if (value === 'this') return element;
    if (value === 'this.value') return element.value;
    if (value === 'this.checked') return element.checked;
    if (value === 'this.files') return element.files;
    if (value === 'true') return true;
    if (value === 'false') return false;
    if (value === 'null') return null;
    if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(value)) return Number(value);
    const encoded = value.match(/^encodeURIComponent\((.*)\)$/);
    if (encoded) return encodeURIComponent(resolveValue(encoded[1], event, element));
    const object = value.match(/^\{([\s\S]*)\}$/);
    if (object) {
      const result = {};
      for (const item of splitArgs(object[1])) {
        const colon = item.indexOf(':');
        if (colon < 0) continue;
        const key = item.slice(0, colon).trim().replace(/^['"]|['"]$/g, '');
        result[key] = resolveValue(item.slice(colon + 1), event, element);
      }
      return result;
    }
    return value;
  }
  function invoke(expression, event, element) {
    let action = decode(expression).trim();
    if (!action) return;
    const condition = action.match(/^if\s*\(\s*event\.key\s*===\s*['"]([^'"]+)['"]\s*\)\s*\{([\s\S]*)\}$/);
    if (condition) { if (event.key !== condition[1]) return; action = condition[2].trim(); }
    const statements = [];
    let start = 0, depth = 0, quote = null;
    for (let i = 0; i < action.length; i++) {
      const ch = action[i];
      if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = null; continue; }
      if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
      if ('([{'.includes(ch)) depth++;
      else if (')]}'.includes(ch)) depth--;
      else if (ch === ';' && depth === 0) { statements.push(action.slice(start, i).trim()); start = i + 1; }
    }
    statements.push(action.slice(start).trim());
    for (const statement of statements) {
      if (statement === 'event.stopPropagation()') { event.stopPropagation(); continue; }
      if (statement === 'event.preventDefault()') { event.preventDefault(); continue; }
      if (statement === 'window.print()') { global.print(); continue; }
      const clickTarget = statement.match(/^document\.getElementById\((['"])([^'"]+)\1\)\.click\(\)$/);
      if (clickTarget) { document.getElementById(clickTarget[2])?.click(); continue; }
      const conditional = statement.match(/^if\s*\(\s*typeof\s+([A-Za-z_$][\w$]*)\s*===\s*['"]function['"]\s*\)\s*([\s\S]+)$/);
      if (conditional) {
        if (typeof global[conditional[1]] === 'function') invoke(conditional[2].trim(), event, element);
        continue;
      }
      const style = statement.match(/^this\.style\.([A-Za-z-]+)\s*=\s*(['"])(.*?)\2$/);
      if (style) { element.style[style[1]] = style[3]; continue; }
      const title = statement.match(/^this\.title\s*=\s*(['"])(.*?)\1$/);
      if (title) { element.title = title[2]; continue; }
      const call = statement.match(/^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\s*\(([\s\S]*)\)$/);
      if (!call) continue;
      const name = call[1];
      if (!actionNames.has(name) && name !== 'openImageLightbox') continue;
      const fn = name.split('.').reduce((target, key) => target && target[key], global);
      if (typeof fn === 'function') fn(...splitArgs(call[2]).map(arg => resolveValue(arg, event, element)));
    }
  }
  function dispatch(event, attribute) {
    let element = event.target;
    while (element && element !== document) {
      if (element.getAttribute) {
        const expression = element.getAttribute(attribute);
        if (expression) {
          invoke(expression, event, element);
          if (event.cancelBubble) break;
        }
      }
      element = element.parentElement;
    }
  }
  document.addEventListener('click', event => dispatch(event, 'data-action'));
  document.addEventListener('change', event => dispatch(event, 'data-action-change'));
  document.addEventListener('submit', event => dispatch(event, 'data-action-submit'));
  document.addEventListener('input', event => dispatch(event, 'data-action-input'));
  document.addEventListener('keydown', event => dispatch(event, 'data-action-keydown'));
  document.addEventListener('error', event => dispatch(event, 'data-action-error'), true);
  document.addEventListener('mouseover', event => dispatch(event, 'data-action-mouseover'));
  document.addEventListener('mouseout', event => dispatch(event, 'data-action-mouseout'));
})(window);
