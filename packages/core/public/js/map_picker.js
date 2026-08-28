/**
 * 视汇 (VFusion) - 离线高德地图选点拾取器组件 (Map Point Picker)
 * 支持 100% 物理隔离网离线运行、高德离线瓦片渲染、交互式打点与经纬度一键回填
 */

(function (global) {
  let mapInstance = null;
  let activeMarker = null;
  let pointLayerGroup = null;
  let currentLng = null;
  let currentLat = null;
  let currentCallback = null;
  let mapConfigCache = null;

  const ACTIVE_PIN_ICON = typeof L !== 'undefined' ? L.divIcon({
    className: 'vfusion-active-pin',
    html: `<svg width="34" height="44" viewBox="0 0 32 42" fill="none" xmlns="http://www.w3.org/2000/svg" style="filter: drop-shadow(0 3px 6px rgba(37,99,235,0.45)); cursor: grab;">
      <path d="M16 0C7.163 0 0 7.163 0 16c0 12 16 26 16 26s16-14 16-26c0-8.837-7.163-16-16-16z" fill="#2563eb"/>
      <circle cx="16" cy="16" r="7" fill="#ffffff"/>
      <circle cx="16" cy="16" r="3.8" fill="#1d4ed8"/>
    </svg>`,
    iconSize: [34, 44],
    iconAnchor: [17, 44],
    popupAnchor: [0, -40]
  }) : null;

  const EXISTING_CAMERA_ICON = typeof L !== 'undefined' ? L.divIcon({
    className: 'vfusion-camera-pin',
    html: `<svg width="26" height="34" viewBox="0 0 32 42" fill="none" xmlns="http://www.w3.org/2000/svg" style="filter: drop-shadow(0 2px 4px rgba(0,0,0,0.3)); cursor: pointer;">
      <path d="M16 0C7.163 0 0 7.163 0 16c0 12 16 26 16 26s16-14 16-26c0-8.837-7.163-16-16-16z" fill="#059669"/>
      <circle cx="16" cy="16" r="6" fill="#ffffff"/>
      <circle cx="16" cy="16" r="3" fill="#059669"/>
    </svg>`,
    iconSize: [26, 34],
    iconAnchor: [13, 34],
    popupAnchor: [0, -32]
  }) : null;

  function ensureModalDom() {
    if (document.getElementById('vfusionMapPickerModal')) return;

    const modalHtml = `
      <div id="vfusionMapPickerModal" class="modal-overlay" style="display:none; position:fixed; inset:0; background:rgba(15,23,42,0.6); z-index:9999; justify-content:center; align-items:center; backdrop-filter:blur(3px);">
        <div class="card" style="width:92vw; max-width:960px; height:88vh; max-height:740px; display:flex; flex-direction:column; background:#ffffff; border-radius:12px; box-shadow:0 25px 50px -12px rgba(0,0,0,0.25); overflow:hidden; border:1px solid #cbd5e1;">
          
          <!-- 弹窗顶栏 -->
          <div style="padding:0.75rem 1.25rem; border-bottom:1px solid #e2e8f0; display:flex; justify-content:space-between; align-items:center; background:#f8fafc; flex-shrink:0;">
            <div style="display:flex; align-items:center; gap:0.6rem;">
              <svg class="icon-svg" viewBox="0 0 24 24" style="color:var(--primary); width:20px; height:20px;"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg>
              <div>
                <h3 id="mapPickerModalTitle" style="font-size:0.95rem; font-weight:700; color:#1e293b; margin:0;">高德离线地图选点拾取</h3>
                <div style="font-size:0.75rem; color:#64748b;">点击地图任意位置放置选点图钉，支持拖拽图钉微调位置</div>
              </div>
            </div>
            <div style="display:flex; align-items:center; gap:0.5rem;">
              <div style="display:flex; align-items:center; background:#eff6ff; border:1px solid #bfdbfe; padding:0.25rem 0.65rem; border-radius:6px; font-size:0.75rem; color:#1e40af; gap:0.4rem;">
                <strong>当前坐标:</strong>
                <span id="mapPickerLngDisplay" style="font-family:monospace; font-weight:600;">-</span> , 
                <span id="mapPickerLatDisplay" style="font-family:monospace; font-weight:600;">-</span>
              </div>
              <button type="button" class="btn btn-secondary" style="padding:0.25rem 0.55rem; font-size:0.8rem; border-radius:6px;" data-action="closeMapPicker()">关闭</button>
            </div>
          </div>

          <!-- 地图操作与快捷定位工具栏 -->
          <div style="padding:0.45rem 1.25rem; background:#ffffff; border-bottom:1px solid #f1f5f9; display:flex; justify-content:space-between; align-items:center; gap:0.75rem; flex-shrink:0; flex-wrap:wrap;">
            <div style="display:flex; align-items:center; gap:0.4rem; flex:1; max-width:480px;">
              <input id="mapPickerManualInput" type="text" placeholder="输入经纬度快速定位 (如 116.3974, 39.9092)" style="font-size:0.75rem; padding:0.3rem 0.55rem; width:100%; border:1px solid #cbd5e1; border-radius:6px;" data-action-keydown="if(event.key==='Enter'){event.preventDefault();jumpToManualCoordinates();}">
              <button type="button" class="btn btn-secondary" style="padding:0.3rem 0.6rem; font-size:0.75rem;" data-action="jumpToManualCoordinates()">定位</button>
            </div>
            <div style="display:flex; align-items:center; gap:0.4rem;">
              <button type="button" class="btn btn-secondary" style="padding:0.3rem 0.6rem; font-size:0.75rem;" data-action="resetMapPickerCenter()">默认中心</button>
              <button type="button" class="btn btn-secondary" style="padding:0.3rem 0.6rem; font-size:0.75rem;" data-action="clearMapPickerPin()">清除选点</button>
            </div>
          </div>

          <!-- 地图展示主体容器 -->
          <div style="flex:1; position:relative; background:#f8fafc; min-height:0;">
            <div id="vfusionLeafletMapContainer" style="width:100%; height:100%; position:absolute; inset:0; z-index:1;"></div>
          </div>

          <!-- 弹窗底栏操作 -->
          <div style="padding:0.65rem 1.25rem; border-top:1px solid #e2e8f0; background:#f8fafc; display:flex; justify-content:space-between; align-items:center; flex-shrink:0;">
            <div style="font-size:0.74rem; color:#64748b; display:flex; align-items:center; gap:0.4rem;">
              <span>离线瓦片托管于本地 <code style="background:#e2e8f0; padding:0.1rem 0.3rem; border-radius:4px;">storage/tiles/</code> 目录</span>
            </div>
            <div style="display:flex; gap:0.5rem;">
              <button type="button" class="btn btn-secondary" style="padding:0.4rem 0.85rem; font-size:0.8rem;" data-action="closeMapPicker()">取消</button>
              <button type="button" class="btn btn-primary" style="padding:0.4rem 1.1rem; font-size:0.8rem; font-weight:700;" data-action="confirmMapPickerSelection()">确认选定坐标并填入</button>
            </div>
          </div>

        </div>
      </div>
    `;

    const div = document.createElement('div');
    div.innerHTML = modalHtml;
    document.body.appendChild(div.firstElementChild);
  }

  async function fetchMapConfig() {
    if (mapConfigCache) return mapConfigCache;
    try {
      const res = await fetch('/api/config/map');
      const json = await res.json();
      if (json.success && json.data) {
        mapConfigCache = json.data;
        return mapConfigCache;
      }
    } catch (e) {
      console.warn('读取地图配置失败，使用默认值:', e);
    }
    mapConfigCache = {
      tile_url_template: '/api/map/tiles/{z}/{x}/{y}.png',
      default_center: [116.397428, 39.909230],
      default_zoom: 12,
      min_zoom: 3,
      max_zoom: 18
    };
    return mapConfigCache;
  }

  async function initLeafletMap() {
    if (typeof L === 'undefined') {
      console.error('Leaflet 未加载，无法初始化地图');
      return;
    }

    const config = await fetchMapConfig();
    const mapContainer = document.getElementById('vfusionLeafletMapContainer');
    if (!mapContainer) return;

    if (!mapInstance) {
      const center = config.default_center || [116.397428, 39.909230];
      // Leaflet uses [lat, lng]
      const initialLat = Array.isArray(center) ? Number(center[1]) : 39.909230;
      const initialLng = Array.isArray(center) ? Number(center[0]) : 116.397428;

      mapInstance = L.map('vfusionLeafletMapContainer', {
        center: [initialLat, initialLng],
        zoom: config.default_zoom || 12,
        minZoom: config.min_zoom || 3,
        maxZoom: config.max_zoom || 18,
        zoomControl: true,
        attributionControl: false
      });

      L.tileLayer(config.tile_url_template || '/api/map/tiles/{z}/{x}/{y}.png', {
        minZoom: config.min_zoom || 3,
        maxZoom: config.max_zoom || 18,
        tileSize: 256,
        zoomOffset: 0
      }).addTo(mapInstance);

      pointLayerGroup = L.layerGroup().addTo(mapInstance);

      mapInstance.on('click', (e) => {
        setMapPin(e.latlng.lng, e.latlng.lat, true);
      });
    }
  }

  function setMapPin(lng, lat, panTo = false) {
    if (lng === null || lat === null || isNaN(Number(lng)) || isNaN(Number(lat))) {
      clearMapPin();
      return;
    }

    currentLng = Number(Number(lng).toFixed(6));
    currentLat = Number(Number(lat).toFixed(6));

    const lngEl = document.getElementById('mapPickerLngDisplay');
    const latEl = document.getElementById('mapPickerLatDisplay');
    const inputEl = document.getElementById('mapPickerManualInput');

    if (lngEl) lngEl.innerText = currentLng;
    if (latEl) latEl.innerText = currentLat;
    if (inputEl) inputEl.value = `${currentLng}, ${currentLat}`;

    if (!mapInstance || typeof L === 'undefined') return;

    const icon = ACTIVE_PIN_ICON || L.divIcon({ className: 'default-pin' });

    if (!activeMarker) {
      activeMarker = L.marker([currentLat, currentLng], {
        icon: icon,
        draggable: true,
        zIndexOffset: 1000
      }).addTo(mapInstance);

      activeMarker.on('dragend', (e) => {
        const pos = e.target.getLatLng();
        setMapPin(pos.lng, pos.lat, false);
      });
    } else {
      activeMarker.setLatLng([currentLat, currentLng]);
    }

    if (panTo && mapInstance) {
      mapInstance.panTo([currentLat, currentLng]);
    }
  }

  function clearMapPickerPin() {
    currentLng = null;
    currentLat = null;
    const lngEl = document.getElementById('mapPickerLngDisplay');
    const latEl = document.getElementById('mapPickerLatDisplay');
    const inputEl = document.getElementById('mapPickerManualInput');
    if (lngEl) lngEl.innerText = '-';
    if (latEl) latEl.innerText = '-';
    if (inputEl) inputEl.value = '';

    if (activeMarker && mapInstance) {
      mapInstance.removeLayer(activeMarker);
      activeMarker = null;
    }
  }

  function clearMapPin() {
    clearMapPickerPin();
  }

  async function loadExistingMonitoringPointsOnMap() {
    if (!pointLayerGroup) return;
    pointLayerGroup.clearLayers();

    try {
      const res = await fetch('/api/monitoring-points?include_disabled=1&limit=500');
      const json = await res.json();
      if (json.success && Array.isArray(json.data)) {
        const icon = EXISTING_CAMERA_ICON || L.divIcon({ className: 'cam-pin' });
        json.data.forEach(p => {
          if (p.longitude !== null && p.latitude !== null && !isNaN(Number(p.longitude)) && !isNaN(Number(p.latitude))) {
            const m = L.marker([Number(p.latitude), Number(p.longitude)], { icon }).addTo(pointLayerGroup);
            m.bindPopup(`
              <div style="font-size:0.78rem; line-height:1.4;">
                <strong style="color:#1e293b; font-size:0.82rem;">${escapeHtml(p.name)}</strong><br>
                <span style="color:#64748b;">编号: <code>${escapeHtml(p.point_id)}</code></span><br>
                <span style="color:#0284c7;">坐标: ${p.longitude}, ${p.latitude}</span><br>
                <button type="button" class="btn btn-primary" style="margin-top:0.35rem; padding:0.25rem 0.6rem; font-size:0.725rem;" data-action="selectExistingPointCoord(${p.longitude}, ${p.latitude}, '${escapeHtml(p.name)}', '${escapeHtml(p.point_id)}')">选择此点位坐标</button>
              </div>
            `);
          }
        });
      }
    } catch (e) {}
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[m]);
  }

  /**
   * 打开地图选点弹窗
   * @param {Object} options
   * @param {number|string} [options.initialLng] 初始经度
   * @param {number|string} [options.initialLat] 初始纬度
   * @param {string} [options.title] 弹窗标题
   * @param {boolean} [options.showExistingPoints=true] 是否显示已存在监控点位图层
   * @param {Function} options.onConfirm 选定后的回调函数 (lng, lat, pointMeta)
   */
  async function openMapPicker(options = {}) {
    ensureModalDom();
    currentCallback = typeof options.onConfirm === 'function' ? options.onConfirm : null;

    const modal = document.getElementById('vfusionMapPickerModal');
    const titleEl = document.getElementById('mapPickerModalTitle');
    if (titleEl && options.title) titleEl.innerText = options.title;

    modal.style.display = 'flex';

    await initLeafletMap();

    if (options.showExistingPoints !== false) {
      loadExistingMonitoringPointsOnMap();
    }

    if (options.initialLng && options.initialLat) {
      setMapPin(options.initialLng, options.initialLat, true);
    } else {
      clearMapPin();
      const config = await fetchMapConfig();
      const center = config.default_center || [116.397428, 39.909230];
      mapInstance.setView([Number(center[1]), Number(center[0])], config.default_zoom || 12);
    }

    setTimeout(() => {
      if (mapInstance) mapInstance.invalidateSize();
    }, 200);
  }

  function closeMapPicker() {
    const modal = document.getElementById('vfusionMapPickerModal');
    if (modal) modal.style.display = 'none';
    currentCallback = null;
  }

  function confirmMapPickerSelection() {
    if (currentLng === null || currentLat === null) {
      if (typeof showToast === 'function') showToast('请先在地图上点击选择坐标点！', 'warn');
      else alert('请先在地图上点击选择坐标点！');
      return;
    }

    if (typeof currentCallback === 'function') {
      currentCallback(currentLng, currentLat);
    }

    if (typeof showToast === 'function') {
      showToast(`已选定坐标: ${currentLng}, ${currentLat}`);
    }

    closeMapPicker();
  }

  function jumpToManualCoordinates() {
    const raw = document.getElementById('mapPickerManualInput')?.value.trim();
    if (!raw) return;
    const parts = raw.split(/[,，\s]+/).filter(Boolean);
    if (parts.length >= 2) {
      const lng = parseFloat(parts[0]);
      const lat = parseFloat(parts[1]);
      if (!isNaN(lng) && !isNaN(lat) && lng >= -180 && lng <= 180 && lat >= -90 && lat <= 90) {
        setMapPin(lng, lat, true);
      } else {
        if (typeof showToast === 'function') showToast('经纬度数值不合法，请检查 (-180~180, -90~90)', 'error');
      }
    }
  }

  async function resetMapPickerCenter() {
    const config = await fetchMapConfig();
    const center = config.default_center || [116.397428, 39.909230];
    if (mapInstance) {
      mapInstance.setView([Number(center[1]), Number(center[0])], config.default_zoom || 12);
    }
  }

  function selectExistingPointCoord(lng, lat, name, id) {
    setMapPin(lng, lat, true);
    if (mapInstance) mapInstance.closePopup();
  }

  global.openMapPicker = openMapPicker;
  global.closeMapPicker = closeMapPicker;
  global.confirmMapPickerSelection = confirmMapPickerSelection;
  global.clearMapPickerPin = clearMapPickerPin;
  global.jumpToManualCoordinates = jumpToManualCoordinates;
  global.resetMapPickerCenter = resetMapPickerCenter;
  global.selectExistingPointCoord = selectExistingPointCoord;

  Object.assign(global.VFusionActions = global.VFusionActions || {}, {
    openMapPicker, closeMapPicker, confirmMapPickerSelection, clearMapPickerPin,
    jumpToManualCoordinates, resetMapPickerCenter, selectExistingPointCoord
  });
})(window);
