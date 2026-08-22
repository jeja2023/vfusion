const fs = require('fs');
const crypto = require('crypto');
const { readJson } = require('./json_store');

function parseCoordinate(value, min, max) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const number = Number(String(value).trim());
  if (!Number.isFinite(number) || number < min || number > max) return null;
  return Number(number.toFixed(7));
}

function normalizeCoordinates(longitude, latitude) {
  const rawLongitude = longitude === undefined || longitude === null ? '' : String(longitude).trim();
  const rawLatitude = latitude === undefined || latitude === null ? '' : String(latitude).trim();
  if (!rawLongitude && !rawLatitude) return null;
  const normalizedLongitude = parseCoordinate(rawLongitude, -180, 180);
  const normalizedLatitude = parseCoordinate(rawLatitude, -90, 90);
  if (normalizedLongitude === null || normalizedLatitude === null) {
    throw new Error('经度必须在 -180 至 180 之间，纬度必须在 -90 至 90 之间，且必须成对填写');
  }
  return { longitude: normalizedLongitude, latitude: normalizedLatitude };
}

function normalizeText(value, label, maxLength, required = false) {
  const text = value === undefined || value === null ? '' : String(value).trim();
  if (required && !text) throw new Error(`${label}不能为空`);
  if (text.length > maxLength) throw new Error(`${label}长度不能超过 ${maxLength} 个字符`);
  return text;
}

function normalizeMonitoringPoint(input, pointIdOverride) {
  const body = input && typeof input === 'object' ? input : {};
  const pointId = normalizeText(pointIdOverride || body.point_id, '点位编号', 64, true);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(pointId)) {
    throw new Error('点位编号仅允许字母、数字、下划线和短横线，且首字符不能为符号');
  }
  const name = normalizeText(body.name, '点位名称', 128, true);
  const location = normalizeText(body.location || name, '地点名称', 256, true);
  const description = normalizeText(body.description, '点位说明', 500);
  const coordinates = normalizeCoordinates(body.longitude, body.latitude);
  return {
    point_id: pointId,
    name,
    location,
    longitude: coordinates ? coordinates.longitude : null,
    latitude: coordinates ? coordinates.latitude : null,
    description,
    enabled: body.enabled !== false,
    created_at: body.created_at || new Date().toISOString(),
    updated_at: body.updated_at || new Date().toISOString()
  };
}

function readMonitoringPoints(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  const raw = readJson(filePath, []);
  if (!Array.isArray(raw)) return [];
  return raw.map(item => {
    try {
      return normalizeMonitoringPoint(item, item && item.point_id);
    } catch (e) {
      return null;
    }
  }).filter(Boolean);
}

function findMonitoringPoint(points, pointId, includeDisabled = false) {
  const id = String(pointId || '').trim();
  return (points || []).find(point => point.point_id === id && (includeDisabled || point.enabled !== false)) || null;
}

function applyMonitoringPoint(payload, point) {
  const target = payload && typeof payload === 'object' ? payload : {};
  target.monitoring_point_id = point.point_id;
  target.monitoring_point_name = point.name;
  target.location = point.location || point.name;
  if (point.longitude !== null && point.latitude !== null) {
    target.longitude = point.longitude;
    target.latitude = point.latitude;
  } else {
    delete target.longitude;
    delete target.latitude;
  }
  target.location_source = 'MONITORING_POINT';
  return target;
}

function createMonitoringPointId(prefix = 'USER') {
  return `${prefix}_${Date.now().toString(36).toUpperCase()}_${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function csvCell(value) {
  const text = value === undefined || value === null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function monitoringPointsToCsv(points) {
  const headers = ['point_id', 'name', 'location', 'longitude', 'latitude', 'description', 'enabled', 'created_at', 'updated_at'];
  const rows = (points || []).map(point => headers.map(key => csvCell(point[key])).join(','));
  return [headers.join(','), ...rows].join('\r\n') + '\r\n';
}

module.exports = {
  parseCoordinate,
  normalizeCoordinates,
  normalizeMonitoringPoint,
  readMonitoringPoints,
  findMonitoringPoint,
  applyMonitoringPoint,
  createMonitoringPointId,
  monitoringPointsToCsv
};
