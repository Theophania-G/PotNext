/** 格式化工具 */
export function formatTime(sec, { alwaysHours = false } = {}) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  const p = (n) => String(n).padStart(2, '0');
  return (h > 0 || alwaysHours) ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
}

export function formatSize(bytes) {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = bytes;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function baseName(p) {
  if (!p) return '';
  const parts = String(p).split(/[\\/]/);
  const name = parts[parts.length - 1] || p;
  return name.replace(/\.[^.]+$/, '');
}

export function extOf(p) {
  const m = /\.([^.\\/]+)$/.exec(p || '');
  return m ? m[1].toLowerCase() : '';
}

/** 简单稳定 id */
let seq = 0;
export const uid = (prefix = 'id') => `${prefix}-${Date.now().toString(36)}-${(seq++).toString(36)}`;
