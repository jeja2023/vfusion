/**
 * 视汇 (VFusion) - 离线高德地图选点与时序轨迹可视化组件 (Map Picker & Track Viewer)
 * 支持 100% 物理隔离网离线运行、高德离线瓦片渲染、交互式选点与任务行动轨迹全景回放
 */

(function (global) {
  let mapInstance = null;
  let activeMarker = null;
  let pointLayerGroup = null;
  let trackLayerGroup = null;
  let currentLng = null;
  let currentLat = null;
  let currentCallback = null;
  let mapConfigCache = null;

  // 轨迹回放状态
  let currentTrackPoints = [];
  let currentTrackMarkerIndex = 0;
  let trackMarkersList = [];
  let currentModalMode = 'PICKER'; // 'PICKER' | 'TRACK'

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

  function createTrackWaypointIcon(idx, total) {
    if (typeof L === 'undefined') return null;
    const isStart = idx === 0;
    const isEnd = idx === total - 1 && total > 1;

    let bgColor = '#2563eb';
    let text = `${idx + 1}`;
    if (isStart) {
      bgColor = '#16a34a';
      text = '起';
    } else if (isEnd) {
      bgColor = '#dc2626';
      text = '终';
    }

    return L.divIcon({
      className: 'vfusion-track-pin',
      html: `
        <div style="position:relative; width:32px; height:40px; display:flex; flex-direction:column; align-items:center; cursor:pointer; filter:drop-shadow(0 3px 6px rgba(0,0,0,0.35));">
          <div style="width:28px; height:28px; border-radius:50%; background:${bgColor}; border:2.5px solid #ffffff; color:#ffffff; font-weight:800; font-size:12px; display:flex; align-items:center; justify-content:center; box-shadow:0 2px 4px rgba(0,0,0,0.2);">
            ${text}
          </div>
          <div style="width:0; height:0; border-left:5px solid transparent; border-right:5px solid transparent; border-top:8px solid ${bgColor}; margin-top:-1px;"></div>
        </div>
      `,
      iconSize: [32, 40],
      iconAnchor: [16, 36],
      popupAnchor: [0, -34]
    });
  }

  function ensureModalDom() {
    if (document.getElementById('vfusionMapPickerModal')) return;

    const modalHtml = `
      <div id="vfusionMapPickerModal" class="modal-overlay" style="display:none; position:fixed; inset:0; background:rgba(15,23,42,0.6); z-index:9999; justify-content:center; align-items:center; backdrop-filter:blur(3px);">
        <div class="modal-map-dialog">
          
          <!-- 弹窗顶栏 -->
          <div style="padding:0.85rem 1.4rem; border-bottom:1px solid #e2e8f0; display:flex; justify-content:space-between; align-items:center; background:#f8fafc; flex-shrink:0;">
            <div style="display:flex; align-items:center; gap:0.75rem;">
              <div style="width:36px; height:36px; border-radius:8px; background:rgba(37,99,235,0.08); display:flex; align-items:center; justify-content:center; flex-shrink:0;">
                <svg class="icon-svg" viewBox="0 0 24 24" style="color:var(--primary); width:20px; height:20px;"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg>
              </div>
              <div>
                <h3 id="mapPickerModalTitle" style="font-size:1rem; font-weight:700; color:#1e293b; margin:0 0 0.15rem;">高德离线地图</h3>
                <div id="mapPickerModalSubtitle" style="font-size:0.78rem; color:#64748b;">点击地图任意位置放置选点图钉，支持拖拽图钉微调位置或输入经纬度快速定位</div>
              </div>
            </div>
            <div style="display:flex; align-items:center; gap:0.75rem;">
              <div id="mapPickerCoordBadge" style="display:flex; align-items:center; background:#eff6ff; border:1px solid #bfdbfe; padding:0.4rem 1rem; border-radius:6px; font-size:0.8rem; color:#1e40af; gap:0.6rem; white-space:nowrap;">
                <span style="font-weight:600; color:#1e3a8a;">当前选定:</span>
                <span style="font-family:monospace; font-weight:700;">经度 <span id="mapPickerLngDisplay">-</span></span>
                <span style="color:#93c5fd;">|</span>
                <span style="font-family:monospace; font-weight:700;">纬度 <span id="mapPickerLatDisplay">-</span></span>
              </div>
              <div id="mapTrackStatsBadge" style="display:none; align-items:center; background:#f0fdf4; border:1px solid #bbf7d0; padding:0.4rem 1rem; border-radius:6px; font-size:0.8rem; color:#166534; gap:0.6rem; white-space:nowrap;">
                <span style="font-weight:700; color:#15803d;" id="mapTrackPointsCountText">共 0 个轨迹途经点</span>
              </div>
            </div>
          </div>

          <!-- 地图操作与快捷定位工具栏 (选点模式) -->
          <div id="mapPickerToolbar" style="padding:0.6rem 1.4rem; background:#ffffff; border-bottom:1px solid #e2e8f0; display:flex; justify-content:space-between; align-items:center; gap:1rem; flex-shrink:0;">
            <div style="display:flex; align-items:center; gap:0.5rem; flex:1; max-width:560px;">
              <input id="mapPickerManualInput" type="text" placeholder="输入经纬度快速定位 (如 120.305456, 31.570037)" style="font-size:0.8rem; padding:0.4rem 0.65rem; width:100%; border:1px solid #cbd5e1; border-radius:6px;" data-action-keydown="if(event.key==='Enter'){event.preventDefault();jumpToManualCoordinates();}">
              <button type="button" class="btn btn-secondary" style="padding:0.4rem 0.85rem; font-size:0.8rem; white-space:nowrap;" data-action="jumpToManualCoordinates()">快速定位</button>
            </div>
            <div style="display:flex; align-items:center; gap:0.5rem;">
              <button type="button" class="btn btn-secondary" style="padding:0.4rem 0.85rem; font-size:0.8rem;" data-action="resetMapPickerCenter()">默认中心</button>
              <button type="button" class="btn btn-secondary" style="padding:0.4rem 0.85rem; font-size:0.8rem;" data-action="clearMapPickerPin()">清除选点</button>
            </div>
          </div>

          <!-- 轨迹漫游控制栏 (轨迹模式) -->
          <div id="mapTrackToolbar" style="display:none; padding:0.6rem 1.4rem; background:#ffffff; border-bottom:1px solid #e2e8f0; justify-content:space-between; align-items:center; gap:1rem; flex-shrink:0;">
            <div style="display:flex; align-items:center; gap:0.6rem;">
              <button type="button" class="btn btn-secondary" style="padding:0.35rem 0.75rem; font-size:0.8rem;" data-action="prevTrackPoint()">◀ 上一个点</button>
              <span id="mapTrackCurrentIndexText" style="font-size:0.825rem; font-weight:700; color:#1e293b; min-width:120px; text-align:center;">途经点 1 / 1</span>
              <button type="button" class="btn btn-secondary" style="padding:0.35rem 0.75rem; font-size:0.8rem;" data-action="nextTrackPoint()">下一个点 ▶</button>
            </div>
            <div style="display:flex; align-items:center; gap:0.5rem;">
              <button type="button" class="btn btn-secondary" style="padding:0.35rem 0.85rem; font-size:0.8rem;" data-action="fitTrackBounds()">全屏视野自适应</button>
            </div>
          </div>

          <!-- 地图展示主体容器 -->
          <div style="flex:1; width:100%; min-height:480px; position:relative; background:#f1f5f9; overflow:hidden;">
            <div id="vfusionLeafletMapContainer" style="width:100%; height:100%; position:absolute; inset:0; z-index:1;"></div>
          </div>

          <!-- 弹窗底栏操作 (选点模式) -->
          <div id="mapPickerFooter" style="padding:0.75rem 1.4rem; border-top:1px solid #e2e8f0; background:#f8fafc; display:flex; justify-content:space-between; align-items:center; flex-shrink:0;">
            <div style="font-size:0.78rem; color:#64748b; display:flex; align-items:center; gap:0.4rem;">
              <span>点击地图任意位置拾取坐标，点击确认自动回填表单</span>
            </div>
            <div style="display:flex; gap:0.65rem;">
              <button type="button" class="btn btn-secondary" style="padding:0.45rem 1rem; font-size:0.82rem;" data-action="closeMapPicker()">取消</button>
              <button type="button" class="btn btn-primary" style="padding:0.45rem 1.3rem; font-size:0.82rem; font-weight:700;" data-action="confirmMapPickerSelection()">确认选定坐标并填入</button>
            </div>
          </div>

          <!-- 弹窗底栏操作 (轨迹模式) -->
          <div id="mapTrackFooter" style="display:none; padding:0.75rem 1.4rem; border-top:1px solid #e2e8f0; background:#f8fafc; justify-content:space-between; align-items:center; flex-shrink:0;">
            <div style="font-size:0.78rem; color:#64748b;">
              按时间先后顺序展示抓拍地点与移动路线，点击图钉可查看现场详情与照片
            </div>
            <div style="display:flex; gap:0.65rem;">
              <button type="button" class="btn btn-secondary" style="padding:0.45rem 1.25rem; font-size:0.82rem; font-weight:600;" data-action="closeMapPicker()">关闭轨迹</button>
            </div>
          </div>

        </div>
      </div>
    `;

    const div = document.createElement('div');
    div.innerHTML = modalHtml;
    document.body.appendChild(div.firstElementChild);
  }

  let currentTileLayer = null;

  function parseCoordinates(center) {
    let rawLng = 120.305456;
    let rawLat = 31.570037;
    if (Array.isArray(center) && center.length >= 2) {
      rawLng = Number(center[0]) || 120.305456;
      rawLat = Number(center[1]) || 31.570037;
    } else if (typeof center === 'string') {
      const parts = center.split(/[,，\s]+/).filter(Boolean);
      if (parts.length >= 2) {
        rawLng = parseFloat(parts[0]) || 120.305456;
        rawLat = parseFloat(parts[1]) || 31.570037;
      }
    }
    // 智能防颠倒：中国境内经度约 73~136，纬度约 3~54
    if (rawLng < 60 && rawLat > 60) {
      return { lng: rawLat, lat: rawLng };
    }
    return { lng: rawLng, lat: rawLat };
  }

  async function fetchMapConfig(forceRefresh = false) {
    if (!forceRefresh && mapConfigCache) return mapConfigCache;
    try {
      const res = await fetch('/api/config/map');
      const json = await res.json();
      if (json.success && json.data) {
        mapConfigCache = json.data;
        return mapConfigCache;
      }
    } catch (e) {}
    return {
      tile_url_template: '/api/map/tiles/{z}/{x}/{y}.png',
      default_center: [120.305456, 31.570037],
      default_zoom: 12,
      min_zoom: 3,
      max_zoom: 18
    };
  }

  async function initLeafletMap() {
    if (typeof L === 'undefined') {
      console.error('[VFusion Map] Leaflet 库未载入');
      return;
    }

    const mapContainer = document.getElementById('vfusionLeafletMapContainer');
    if (!mapContainer) return;

    const config = await fetchMapConfig(true);
    const { lng, lat } = parseCoordinates(config.default_center);
    const tileTemplate = config.tile_url_template || '/api/map/tiles/{z}/{x}/{y}.png';

    if (!mapInstance) {
      mapInstance = L.map('vfusionLeafletMapContainer', {
        center: [lat, lng],
        zoom: config.default_zoom || 12,
        minZoom: config.min_zoom || 3,
        maxZoom: config.max_zoom || 18,
        zoomControl: true,
        attributionControl: false
      });

      currentTileLayer = L.tileLayer(tileTemplate, {
        maxZoom: config.max_zoom || 18,
        minZoom: config.min_zoom || 3,
        tileSize: 256,
        zoomOffset: 0
      }).addTo(mapInstance);

      currentTileLayer.on('tileerror', (error) => {
        console.warn('[VFusion Map] 瓦片切片加载异常 (请检查瓦片目录/中心点或代理规则):', error.coords);
      });

      pointLayerGroup = L.layerGroup().addTo(mapInstance);
      trackLayerGroup = L.layerGroup().addTo(mapInstance);

      mapInstance.on('click', (e) => {
        if (currentModalMode !== 'PICKER') return;
        const nLng = Number(e.latlng.lng.toFixed(6));
        const nLat = Number(e.latlng.lat.toFixed(6));
        setMapPin(nLng, nLat, false);
      });
    } else {
      if (currentTileLayer) {
        currentTileLayer.setUrl(tileTemplate);
      }
      mapInstance.setMinZoom(config.min_zoom || 3);
      mapInstance.setMaxZoom(config.max_zoom || 18);
    }
  }

  function setMapPin(lng, lat, shouldCenter = false) {
    currentLng = lng;
    currentLat = lat;

    const lngEl = document.getElementById('mapPickerLngDisplay');
    const latEl = document.getElementById('mapPickerLatDisplay');
    if (lngEl) lngEl.innerText = lng.toFixed(6);
    if (latEl) latEl.innerText = lat.toFixed(6);

    const manualInput = document.getElementById('mapPickerManualInput');
    if (manualInput) manualInput.value = `${lng.toFixed(6)}, ${lat.toFixed(6)}`;

    if (activeMarker) {
      activeMarker.setLatLng([lat, lng]);
    } else if (mapInstance && typeof L !== 'undefined') {
      const icon = ACTIVE_PIN_ICON || L.divIcon({ className: 'active-pin' });
      activeMarker = L.marker([lat, lng], {
        icon: icon,
        draggable: true,
        zIndexOffset: 1000
      }).addTo(mapInstance);

      activeMarker.on('dragend', (event) => {
        const position = event.target.getLatLng();
        const nLng = Number(position.lng.toFixed(6));
        const nLat = Number(position.lat.toFixed(6));
        setMapPin(nLng, nLat, false);
      });
    }

    if (shouldCenter && mapInstance) {
      mapInstance.setView([lat, lng], Math.max(mapInstance.getZoom(), 14));
    }
  }

  function clearMapPin() {
    currentLng = null;
    currentLat = null;
    const lngEl = document.getElementById('mapPickerLngDisplay');
    const latEl = document.getElementById('mapPickerLatDisplay');
    if (lngEl) lngEl.innerText = '-';
    if (latEl) latEl.innerText = '-';

    const manualInput = document.getElementById('mapPickerManualInput');
    if (manualInput) manualInput.value = '';

    if (activeMarker && mapInstance) {
      mapInstance.removeLayer(activeMarker);
      activeMarker = null;
    }
  }

  function clearMapPickerPin() {
    clearMapPin();
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[m]);
  }

  function escapeJsString(str) {
    if (!str) return '';
    return String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
  }

  /**
   * 打开地图选点弹窗 (PICKER 模式)
   */
  async function openMapPicker(options = {}) {
    ensureModalDom();
    currentModalMode = 'PICKER';
    currentCallback = typeof options.onConfirm === 'function' ? options.onConfirm : null;

    const modal = document.getElementById('vfusionMapPickerModal');
    const titleEl = document.getElementById('mapPickerModalTitle');
    const subTitleEl = document.getElementById('mapPickerModalSubtitle');
    if (titleEl) titleEl.innerText = options.title || '高德离线地图选点拾取';
    if (subTitleEl) subTitleEl.innerText = '点击地图任意位置放置选点图钉，支持拖拽图钉微调位置或输入经纬度快速定位';

    // 切换为选点模式 UI
    document.getElementById('mapPickerCoordBadge').style.display = 'flex';
    document.getElementById('mapTrackStatsBadge').style.display = 'none';
    document.getElementById('mapPickerToolbar').style.display = 'flex';
    document.getElementById('mapTrackToolbar').style.display = 'none';
    document.getElementById('mapPickerFooter').style.display = 'flex';
    document.getElementById('mapTrackFooter').style.display = 'none';

    modal.style.display = 'flex';

    await initLeafletMap();

    if (trackLayerGroup) trackLayerGroup.clearLayers();

    if (options.initialLng && options.initialLat) {
      setMapPin(options.initialLng, options.initialLat, true);
    } else {
      clearMapPin();
      const config = await fetchMapConfig(true);
      const { lng, lat } = parseCoordinates(config.default_center);
      if (mapInstance) {
        mapInstance.setView([lat, lng], config.default_zoom || 12);
      }
    }

    [0, 50, 150, 300, 600, 1000].forEach(delay => {
      setTimeout(() => {
        if (mapInstance) mapInstance.invalidateSize(true);
      }, delay);
    });
  }

  /**
   * 打开任务行动轨迹全景展示弹窗 (TRACK 模式)
   */
  async function openTrackMapViewer(options = {}) {
    ensureModalDom();
    currentModalMode = 'TRACK';

    const points = Array.isArray(options.trackPoints) ? options.trackPoints : [];
    currentTrackPoints = points;
    currentTrackMarkerIndex = 0;
    trackMarkersList = [];

    const modal = document.getElementById('vfusionMapPickerModal');
    const titleEl = document.getElementById('mapPickerModalTitle');
    const subTitleEl = document.getElementById('mapPickerModalSubtitle');
    if (titleEl) titleEl.innerText = options.title || `行动轨迹全景 - ${options.taskName || '巡检任务'}`;
    if (subTitleEl) subTitleEl.innerText = `任务编号: ${options.taskCode || '-'} | 按时序先后展示 ${points.length} 个抓拍记录点`;

    // 切换为轨迹模式 UI
    document.getElementById('mapPickerCoordBadge').style.display = 'none';
    document.getElementById('mapTrackStatsBadge').style.display = 'flex';
    document.getElementById('mapTrackPointsCountText').innerText = `共 ${points.length} 个轨迹途经点`;
    document.getElementById('mapPickerToolbar').style.display = 'none';
    document.getElementById('mapTrackToolbar').style.display = 'flex';
    document.getElementById('mapPickerFooter').style.display = 'none';
    document.getElementById('mapTrackFooter').style.display = 'flex';

    modal.style.display = 'flex';

    await initLeafletMap();

    // 清空旧图层
    clearMapPin();
    if (pointLayerGroup) pointLayerGroup.clearLayers();
    if (trackLayerGroup) trackLayerGroup.clearLayers();

    if (points.length === 0) {
      updateTrackStepText();
      return;
    }

    const latlngs = [];

    points.forEach((pt, idx) => {
      const lat = Number(pt.latitude);
      const lng = Number(pt.longitude);
      latlngs.push([lat, lng]);

      const icon = createTrackWaypointIcon(idx, points.length);
      const marker = L.marker([lat, lng], { icon }).addTo(trackLayerGroup);

      const isStart = idx === 0;
      const isEnd = idx === points.length - 1 && points.length > 1;
      let badgeTag = `<span style="background:#2563eb; color:#fff; padding:1px 6px; border-radius:4px; font-size:0.7rem; font-weight:700;">途经点 #${idx + 1}</span>`;
      if (isStart) badgeTag = `<span style="background:#16a34a; color:#fff; padding:1px 6px; border-radius:4px; font-size:0.7rem; font-weight:700;">起点</span>`;
      else if (isEnd) badgeTag = `<span style="background:#dc2626; color:#fff; padding:1px 6px; border-radius:4px; font-size:0.7rem; font-weight:700;">最新 / 终点</span>`;

      const imgHtml = pt.imageUrl ? `
        <div style="margin-top:0.4rem; aspect-ratio:4/3; max-width:180px; border-radius:6px; overflow:hidden; border:1px solid #cbd5e1; background:#000; cursor:pointer;" data-action="openImageLightbox('${escapeJsString(pt.imageUrl)}', '现场照片: ${escapeJsString(pt.location || pt.time || '')}')">
          <img src="${escapeHtml(pt.imageUrl)}" style="width:100%; height:100%; object-fit:cover;" title="点击放大预览照片">
        </div>
      ` : '';

      const personHtml = pt.personName ? `
        <div style="font-size:0.75rem; color:#334155; margin-top:2px;">
          <span style="color:#64748b;">涉事人员:</span> <strong>${escapeHtml(pt.personName)}</strong> ${pt.personIdCard ? `<code>(${escapeHtml(pt.personIdCard)})</code>` : ''}
        </div>
      ` : '';

      marker.bindPopup(`
        <div style="font-size:0.8rem; line-height:1.45; min-width:200px; max-width:260px;">
          <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #e2e8f0; padding-bottom:0.35rem; margin-bottom:0.4rem;">
            ${badgeTag}
            <span style="font-size:0.72rem; color:#64748b; font-family:monospace;">${escapeHtml(pt.time || '')}</span>
          </div>
          <div style="font-size:0.825rem; font-weight:700; color:#1e293b; margin-bottom:2px;">
            ${escapeHtml(pt.location || '现场巡检点')}
          </div>
          ${personHtml}
          <div style="font-size:0.725rem; color:#0284c7; font-family:monospace; margin-top:2px;">
            坐标: ${lng.toFixed(6)}, ${lat.toFixed(6)}
          </div>
          ${imgHtml}
        </div>
      `);

      trackMarkersList.push(marker);
    });

    // 绘制时序折线
    if (latlngs.length > 1) {
      L.polyline(latlngs, {
        color: '#2563eb',
        weight: 4,
        opacity: 0.85,
        dashArray: '6, 8',
        lineCap: 'round',
        lineJoin: 'round'
      }).addTo(trackLayerGroup);
    }

    updateTrackStepText();

    // 视野自适应
    if (latlngs.length > 0) {
      setTimeout(() => {
        if (mapInstance) {
          mapInstance.invalidateSize();
          if (latlngs.length === 1) {
            mapInstance.setView(latlngs[0], 15);
          } else {
            const bounds = L.latLngBounds(latlngs);
            mapInstance.fitBounds(bounds, { padding: [60, 60], maxZoom: 16 });
          }
        }
      }, 150);
    }
  }

  function updateTrackStepText() {
    const textEl = document.getElementById('mapTrackCurrentIndexText');
    if (!textEl) return;
    if (currentTrackPoints.length === 0) {
      textEl.innerText = '暂无轨迹点';
    } else {
      textEl.innerText = `途经点 ${currentTrackMarkerIndex + 1} / ${currentTrackPoints.length}`;
    }
  }

  function jumpToTrackPoint(idx) {
    if (!currentTrackPoints.length || idx < 0 || idx >= currentTrackPoints.length) return;
    currentTrackMarkerIndex = idx;
    updateTrackStepText();

    const pt = currentTrackPoints[idx];
    const marker = trackMarkersList[idx];
    if (mapInstance && pt) {
      mapInstance.panTo([Number(pt.latitude), Number(pt.longitude)], { animate: true, duration: 0.4 });
      if (marker) {
        setTimeout(() => marker.openPopup(), 250);
      }
    }
  }

  function prevTrackPoint() {
    if (!currentTrackPoints.length) return;
    let nextIdx = currentTrackMarkerIndex - 1;
    if (nextIdx < 0) nextIdx = currentTrackPoints.length - 1;
    jumpToTrackPoint(nextIdx);
  }

  function nextTrackPoint() {
    if (!currentTrackPoints.length) return;
    let nextIdx = currentTrackMarkerIndex + 1;
    if (nextIdx >= currentTrackPoints.length) nextIdx = 0;
    jumpToTrackPoint(nextIdx);
  }

  function fitTrackBounds() {
    if (!currentTrackPoints.length || !mapInstance || typeof L === 'undefined') return;
    const latlngs = currentTrackPoints.map(p => [Number(p.latitude), Number(p.longitude)]);
    if (latlngs.length === 1) {
      mapInstance.setView(latlngs[0], 15);
    } else {
      const bounds = L.latLngBounds(latlngs);
      mapInstance.fitBounds(bounds, { padding: [60, 60], maxZoom: 16 });
    }
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
    const config = await fetchMapConfig(true);
    const { lng, lat } = parseCoordinates(config.default_center);
    if (mapInstance) {
      mapInstance.setView([lat, lng], config.default_zoom || 12);
    }
  }

  global.openMapPicker = openMapPicker;
  global.openTrackMapViewer = openTrackMapViewer;
  global.closeMapPicker = closeMapPicker;
  global.confirmMapPickerSelection = confirmMapPickerSelection;
  global.clearMapPickerPin = clearMapPickerPin;
  global.clearMapPin = clearMapPin;
  global.jumpToManualCoordinates = jumpToManualCoordinates;
  global.resetMapPickerCenter = resetMapPickerCenter;
  global.prevTrackPoint = prevTrackPoint;
  global.nextTrackPoint = nextTrackPoint;
  global.fitTrackBounds = fitTrackBounds;

  Object.assign(global.VFusionActions = global.VFusionActions || {}, {
    openMapPicker, openTrackMapViewer, closeMapPicker, confirmMapPickerSelection, clearMapPickerPin, clearMapPin,
    jumpToManualCoordinates, resetMapPickerCenter, prevTrackPoint, nextTrackPoint, fitTrackBounds
  });
})(window);
