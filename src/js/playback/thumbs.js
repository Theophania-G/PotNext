/**
 * 视频缩略图：懒生成 + 磁盘缓存
 * - 用隐藏 <video> 加载元数据，跳到时长 10% 处（避开片头黑场）截帧
 * - 160×90 JPEG 写入用户数据目录 thumbs/，playlists.json 只存缓存路径
 * - 队列化双并发处理；失败静默降级（不重试），不打扰用户；生成时顺带解出媒体时长
 */
const W = 160, H = 90;
const SEEK_RATIO = 0.1;        // 跳到时长的 10%
const SEEK_MIN = 1;            // 至少 1s（短片）
const SEEK_MAX = 10;           // 最多 10s（避开片头）
const JOB_TIMEOUT = 8000;

/* path → Promise<缓存路径|null>，去重 + 记忆 */
const memo = new Map();
/* 待处理队列：{ path, resolve } */
const queue = [];
let running = false;
let video = null;
let canvas = null;

/** 路径 → 稳定缓存键（Windows 路径不区分大小写，先归一） */
function hashOf(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function ensureVideo() {
  if (video) return;
  video = document.createElement('video');
  video.preload = 'metadata';
  video.muted = true;
  video.defaultMuted = true;
  video.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;left:-9999px';
  document.body.append(video);
  canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
}

const fileUrl = (p) => `file:///${p.replace(/\\/g, '/')}`;

/** 缓存路径 → <img> 可用 URL */
export const toImgSrc = (cachePath) => (cachePath ? fileUrl(cachePath) : null);

/** 生成单张：加载 → 定位 → 截帧 → 交主进程写缓存；顺带把媒体时长带回来 */
function capture(path) {
  return new Promise((resolve) => {
    ensureVideo();
    let settled = false;
    let dur = 0;
    const done = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.removeEventListener('loadedmetadata', onMeta);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onErr);
      video.removeAttribute('src');
      video.load();
      resolve(val ? { cachePath: val, duration: dur } : null);
    };
    const timer = setTimeout(() => done(null), JOB_TIMEOUT);

    const onMeta = () => {
      const d = isFinite(video.duration) ? video.duration : 0;
      dur = d;
      const t = d ? Math.min(Math.max(d * SEEK_RATIO, SEEK_MIN), Math.min(SEEK_MAX, d * 0.5)) : 0;
      if (t > 0.1) video.currentTime = t;
      else onSeeked(); /* 无时长信息时直接截当前帧 */
    };
    const onSeeked = async () => {
      try {
        const vw = video.videoWidth, vh = video.videoHeight;
        if (!vw || !vh) return done(null);
        /* cover 裁切到 16:9 */
        const scale = Math.max(W / vw, H / vh);
        const dw = vw * scale, dh = vh * scale;
        canvas.getContext('2d').drawImage(video, (W - dw) / 2, (H - dh) / 2, dw, dh);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.72);
        const cachePath = await window.potnext.thumbCache(hashOf(path.toLowerCase()), dataUrl);
        done(cachePath || null);
      } catch {
        done(null);
      }
    };
    const onErr = () => done(null);

    video.addEventListener('loadedmetadata', onMeta);
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('error', onErr);
    video.src = fileUrl(path);
    video.load();
  });
}

/** 队列消费：双并发（翻页浏览时缩略图不至于一张张爬） */
const PUMP_CONCURRENCY = 2;
let active = 0;

async function pump() {
  while (queue.length && active < PUMP_CONCURRENCY) {
    active += 1;
    const job = queue.shift();
    capture(job.path)
      .then((r) => job.resolve(r))
      .finally(() => { active -= 1; pump(); });
  }
}

/**
 * 请求缩略图（幂等：同路径复用同一 Promise）。
 * @param {string} path 媒体绝对路径
 * @returns {Promise<{cachePath: string, duration: number}|null>}
 *          缓存文件绝对路径 + 媒体时长（仅本次生成时可得，命中旧缓存时 duration=0），失败为 null
 */
export function requestThumb(path) {
  if (!path || !window.potnext?.thumbCache) return Promise.resolve(null);
  if (memo.has(path)) return memo.get(path);

  const p = new Promise((resolve) => {
    /* 先查磁盘缓存，未命中才入队生成 */
    window.potnext.thumbCache(hashOf(path.toLowerCase()), null)
      .then((existing) => {
        if (existing) return resolve({ cachePath: existing, duration: 0 });
        queue.push({ path, resolve });
        pump();
      })
      .catch(() => resolve(null));
  });
  memo.set(path, p);
  return p;
}
