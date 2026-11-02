/** 时间轴：拖拽定位 + 悬停预览 + 缓冲显示
 *  拖动手感：全程只刷本地预览（fill/thumb/时间文本），不逐 move 触发 seek——
 *  逐 move seek 会让解码器反复重定位，表现为拖动卡顿；松手才提交一次 seek。 */
import { $, draggable, formatTime, raf } from '../utils/index.js';
import * as store from '../state/store.js';
import { controls } from '../playback/engine.js';

export function initTimeline() {
  const row = $('#timeline');
  const track = row.querySelector('.tl-track');
  const fill = row.querySelector('.tl-fill');
  const buffered = row.querySelector('.tl-buffered');
  const thumb = row.querySelector('.tl-thumb');
  const preview = row.querySelector('.tl-preview');
  const previewTime = row.querySelector('.tl-preview-time');

  let dragging = false;
  let dragRatio = 0;

  const ratioFromEvent = (e) => {
    const r = track.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  };

  /** 本地预览绘制：拖动中直接按 ratio 画，不经过 store / currentTime */
  const paintRatio = (ratio, d) => {
    fill.style.width = `${ratio * 100}%`;
    thumb.style.left = `${ratio * 100}%`;
    $('#t-cur').textContent = formatTime(ratio * d);
  };

  const paintFromStore = raf(() => {
    if (dragging) return; /* 拖动中预览帧优先，避免 store 时间抢画 */
    const s = store.get();
    const d = s.duration || 0;
    const ratio = d ? s.currentTime / d : 0;
    paintRatio(ratio, d);
    buffered.style.width = `${d ? (s.buffered / d) * 100 : 0}%`;
    $('#t-dur').textContent = formatTime(d);
  });

  /* 播放中 rAF 直读 video.currentTime：store 节流 250ms 只有 4fps，
   * 逐帧刷进度条才够顺滑；暂停/seek 后由 store 事件兜底刷新 */
  let rafId = 0;
  const tick = () => {
    rafId = 0;
    if (dragging) return;
    const d = store.get().duration || 0;
    if (d) {
      paintRatio(controls.time() / d, d);
      $('#t-dur').textContent = formatTime(d);
    }
    if (store.get().playing) rafId = requestAnimationFrame(tick);
  };
  const startTick = () => { if (!rafId && !dragging) rafId = requestAnimationFrame(tick); };

  store.subscribe('currentTime', paintFromStore);
  store.subscribe('duration', paintFromStore);
  store.subscribe('buffered', paintFromStore);
  store.subscribe('playing', (s) => { if (s.playing) startTick(); else paintFromStore(); });

  /* 悬停预览气泡 */
  const movePreview = (e) => {
    const ratio = ratioFromEvent(e);
    const rect = row.getBoundingClientRect();
    preview.style.left = `${ratio * rect.width}px`;
    previewTime.textContent = formatTime(ratio * (store.get().duration || 0));
  };
  row.addEventListener('pointermove', movePreview);

  draggable(track, {
    onStart: (e) => {
      dragging = true;
      dragRatio = ratioFromEvent(e);
      row.classList.add('dragging');
      paintRatio(dragRatio, store.get().duration || 0);
      movePreview(e);
    },
    onMove: (e) => {
      if (!dragging) return;
      dragRatio = ratioFromEvent(e);
      paintRatio(dragRatio, store.get().duration || 0);
      movePreview(e);
    },
    onEnd: () => {
      if (!dragging) return;
      dragging = false;
      row.classList.remove('dragging');
      /* 松手一次性提交 seek */
      controls.seek(dragRatio * (store.get().duration || 0));
      startTick();
    },
  });
}
