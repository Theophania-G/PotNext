/**
 * 播放引擎：包装 <video> 元素，把媒体事件翻译成 store 状态。
 * 上层 UI 不直接触碰 video，只通过本模块 + store。
 */
import * as store from '../state/store.js';
import { baseName, extOf, uid, throttle } from '../utils/index.js';

const VIDEO_EXTS = new Set(['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg', 'ts', 'm2ts', 'rmvb', 'rm', '3gp', 'ogv', 'vob']);
const AUDIO_EXTS = new Set(['mp3', 'flac', 'wav', 'm4a', 'aac', 'ogg', 'opus', 'wma']);

let video = null;
let currentItem = null;
let unloadSaveTimer = null;

/** path 数组 → 播放列表条目 */
export function makeItems(paths) {
  return paths
    .filter((p) => p && (VIDEO_EXTS.has(extOf(p)) || AUDIO_EXTS.has(extOf(p))))
    .map((p) => ({
      id: uid('item'),
      path: p,
      title: baseName(p),
      ext: extOf(p),
      duration: 0,
      lastPosition: 0,
    }));
}

export function attach(el) {
  video = el;
  const s = store.get();

  /* 媒体事件 → store */
  const pushTime = throttle(() => {
    store.set({ currentTime: video.currentTime }, ['currentTime']);
  }, 250);

  video.addEventListener('timeupdate', pushTime);
  video.addEventListener('progress', () => {
    if (video.buffered.length) {
      store.set({ buffered: video.buffered.end(video.buffered.length - 1) }, ['buffered']);
    }
  });
  video.addEventListener('durationchange', () => store.set({ duration: video.duration || 0 }, ['duration']));
  video.addEventListener('play', () => store.set({ playing: true }, ['playing']));
  video.addEventListener('pause', () => store.set({ playing: false }, ['playing']));
  video.addEventListener('ended', onEnded);
  video.addEventListener('volumechange', () => store.set({ volume: video.volume, muted: video.muted }, ['volume', 'muted']));
  video.addEventListener('ratechange', () => store.set({ rate: video.playbackRate }, ['rate']));
  video.addEventListener('error', onError);
  video.addEventListener('loadedmetadata', onMeta);

  /* 初始音量 */
  video.volume = s.volume;

  /* store → 媒体 */
  store.subscribe('currentId', () => {
    const id = store.get().currentId;
    const item = store.get().playlist.find((i) => i.id === id);
    if (item) load(item);
    else stop();
  });
}

function onMeta() {
  if (!currentItem) return;
  store.set({ duration: video.duration || 0 }, ['duration']);
  if (video.duration > 0) {
    store.updateItem(currentItem.id, { duration: video.duration });
  }
  /* 记忆续播 */
  const st = store.get().settings;
  if (st.rememberPosition && currentItem.lastPosition > 3 && currentItem.lastPosition < (video.duration || Infinity) - 5) {
    video.currentTime = currentItem.lastPosition;
  }
}

function onEnded() {
  const s = store.get();
  if (currentItem) store.updateItem(currentItem.id, { lastPosition: 0 });
  if (s.settings.autoPlayNext) store.stepTrack(1);
  else store.set({ playing: false }, ['playing']);
}

function onError() {
  const err = video?.error;
  const msg = err ? { 1: '播放被中止', 2: '网络错误', 3: '解码失败（格式不支持）', 4: '无法加载源文件' }[err.code] || '播放出错' : '播放出错';
  const finish = (text) => {
    store.set({ toast: { text, kind: 'error' } }, ['toast']);
    store.set({ playing: false }, ['playing']);
  };
  /* 源文件被移动/删除是常见情形（尤其整文件夹挪位），提示要能行动 */
  if (err?.code === 4 && currentItem && window.potnext?.exists) {
    window.potnext.exists(currentItem.path).then((ok) =>
      finish(ok ? msg : '源文件不存在（可能被移动或删除），请重新添加文件夹'));
    return;
  }
  finish(msg);
}

async function load(item) {
  if (!video) return;
  savePosition();
  currentItem = item;
  video.src = `file:///${item.path.replace(/\\/g, '/')}`;
  video.load();
  try {
    await video.play();
  } catch {
    /* 自动播放策略或解码失败；保持 paused 状态 */
    store.set({ playing: false }, ['playing']);
  }
  /* 自动挂载同名字幕 */
  if (window.potnext?.findSubtitle) {
    window.potnext.findSubtitle(item.path).then((sub) => {
      if (sub && currentItem?.id === item.id) attachSubtitle(sub);
    });
  }
}

function stop() {
  savePosition();
  if (!video) return;
  video.removeAttribute('src');
  video.load();
  currentItem = null;
  store.set({ playing: false, currentTime: 0, duration: 0 }, ['playing', 'currentTime', 'duration']);
}

function savePosition() {
  if (currentItem && video && isFinite(video.currentTime)) {
    const pos = video.currentTime;
    if (video.duration && pos > 3 && pos < video.duration - 5) {
      store.updateItem(currentItem.id, { lastPosition: pos });
    }
  }
}

/* ---------- 对外控制接口 ---------- */
export const controls = {
  togglePlay() {
    if (!video) return;
    if (!currentItem && store.get().playlist.length) {
      store.set({ currentId: store.get().playlist[0].id }, ['currentId']);
      return;
    }
    video.paused ? video.play().catch(() => {}) : video.pause();
  },
  /** 实时播放头（rAF 直读用，不经 store 节流） */
  time() {
    return video ? video.currentTime : 0;
  },
  seek(t) {
    if (video && isFinite(video.duration)) video.currentTime = Math.max(0, Math.min(t, video.duration));
  },
  seekBy(dt) {
    if (video) controls.seek(video.currentTime + dt);
  },
  setVolume(v) {
    if (!video) return;
    video.volume = Math.max(0, Math.min(1, v));
    if (v > 0) video.muted = false;
  },
  toggleMute() {
    if (video) video.muted = !video.muted;
  },
  setRate(r) {
    if (video) video.playbackRate = r;
  },
  screenshot() {
    if (!video) return;
    const w = video.videoWidth, hgt = video.videoHeight;
    if (!w) return;
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = hgt;
    cv.getContext('2d').drawImage(video, 0, 0);
    const dataUrl = cv.toDataURL('image/png');
    const name = `potnext-${currentItem ? baseName(currentItem.path) : 'shot'}-${Date.now()}.png`;
    window.potnext?.saveShot(dataUrl, name).then((p) => {
      if (p) store.set({ toast: { text: `截图已保存：${p}`, kind: 'success' } }, ['toast']);
    });
  },
  frameStep(dir = 1) {
    if (!video) return;
    video.pause();
    controls.seek(video.currentTime + dir / 30);
  },
  attachSubtitle(filePath) {
    if (!video || !filePath) return;
    /* 移除旧轨道 */
    for (const tr of [...video.querySelectorAll('track')]) tr.remove();
    const ext = extOf(filePath);
    const type = ext === 'vtt' ? 'text/vtt' : 'text/plain';
    const track = document.createElement('track');
    track.kind = 'subtitles';
    track.label = baseName(filePath);
    track.srclang = 'zh';
    track.src = `file:///${filePath.replace(/\\/g, '/')}`;
    track.default = true;
    video.append(track);
    track.addEventListener('load', () => {
      if (track.track) track.track.mode = store.get().settings.showSubtitles ? 'showing' : 'hidden';
    });
    /* 原生 <track> 不支持 srt；vtt 直接可用。srt 用最小转换器（走主进程读取，fetch file:// 被拦截） */
    if (type === 'text/plain') {
      window.potnext?.readText(filePath).then((srt) => {
        if (!srt) return;
        const vtt = srtToVtt(srt);
        track.src = URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }));
        track.track.mode = store.get().settings.showSubtitles ? 'showing' : 'hidden';
      });
    }
  },
  toggleSubtitles(on) {
    for (const tr of video?.querySelectorAll('track') ?? []) {
      tr.track.mode = on ? 'showing' : 'hidden';
    }
  },
  currentItem: () => currentItem,
  element: () => video,
};

/** SRT → WebVTT 最小转换 */
function srtToVtt(srt) {
  const body = srt
    .replace(/\r+/g, '')
    .replace(/^\d+\s*$/gm, '')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  return `WEBVTT\n\n${body}`;
}

/* 离开前保存进度并立即落盘（updateItem 的 debounce 写入在卸载窗口内不会触发） */
window.addEventListener('beforeunload', () => {
  savePosition();
  clearTimeout(unloadSaveTimer);
  store.flushPersist();
});
