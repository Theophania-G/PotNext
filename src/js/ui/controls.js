/**
 * 控制条：传输键微交互、音量/倍速弹层、更多菜单、OSD、自动隐藏。
 * 微交互基准（Mineradio）：hover 0.20s → press 0.10s → spring 0.24s
 */
import { $, $$, draggable } from '../utils/index.js';
import * as store from '../state/store.js';
import { controls } from '../playback/engine.js';

/** 播控唤出热区：窗口下方 25%（至少 140px）。舞台单击/移动共用同一判定 */
export function inSummonBand(clientY) {
  return clientY >= window.innerHeight - Math.max(140, Math.round(window.innerHeight * 0.25));
}

export function initControls() {
  const bar = $('#control-bar');
  const playBtn = $('#btn-play');
  const playUse = playBtn.querySelector('use');

  /* ---- 播放键：状态 + 扩散光环 ---- */
  store.subscribe('playing', (s) => {
    playUse.setAttribute('href', s.playing ? '#i-pause' : '#i-play');
    playBtn.classList.toggle('playing', s.playing);
    playBtn.setAttribute('data-tip', s.playing ? '暂停 (Space)' : '播放 (Space)');
  });

  const bindBtn = (sel, fn) => {
    const btn = $(sel);
    btn.addEventListener('click', fn);
    return btn;
  };

  bindBtn('#btn-play', () => { controls.togglePlay(); showOsd(store.get().playing ? 'pause' : 'play'); });
  bindBtn('#btn-prev', () => store.stepTrack(-1));
  bindBtn('#btn-next', () => store.stepTrack(1));
  bindBtn('#btn-mute', () => controls.toggleMute());
  bindBtn('#btn-fullscreen', () => window.potnext?.fullscreenToggle());
  bindBtn('#btn-open-file', () => window.appActions?.openMedia());
  bindBtn('#btn-open-folder', () => window.appActions?.openFolder());

  /* ---- 音量 ---- */
  const volGroup = $('#volume-group');
  const volFill = volGroup.querySelector('.vol-fill');
  const volThumb = volGroup.querySelector('.vol-thumb');
  const muteBtn = $('#btn-mute');
  const muteUse = muteBtn.querySelector('use');
  const volTrack = volGroup.querySelector('.vol-track');

  const paintVolume = (s) => {
    const v = s.muted ? 0 : s.volume;
    volFill.style.width = `${v * 100}%`;
    volThumb.style.left = `${v * 100}%`;
    muteUse.setAttribute('href', s.muted || v === 0 ? '#i-mute' : v < 0.5 ? '#i-volume-low' : '#i-volume');
    muteBtn.classList.toggle('active', s.muted);
  };
  store.subscribe('volume', paintVolume);
  store.subscribe('muted', paintVolume);
  paintVolume(store.get());

  draggable(volTrack, {
    onStart: (e) => setVol(e),
    onMove: (e) => setVol(e),
  });
  function setVol(e) {
    const r = volTrack.getBoundingClientRect();
    controls.setVolume((e.clientX - r.left) / r.width);
    showVolumeOsd();
  }

  /* 滚轮调音量（悬停在控制条上时） */
  bar.addEventListener('wheel', (e) => {
    if (!e.target.closest('#volume-group, .volume-popover')) return;
    e.preventDefault();
    controls.setVolume((store.get().muted ? 0 : store.get().volume) + (e.deltaY < 0 ? 0.02 : -0.02));
    showVolumeOsd();
  }, { passive: false });

  /* ---- 倍速 ---- */
  const speedGroup = $('#speed-group');
  const speedBtn = $('#btn-speed');
  const speedLabel = speedBtn.querySelector('.speed-label');
  /* 点击钉住弹层：hover 过桥 + .open 双保险，未选完不会缩回 */
  speedBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    speedGroup.classList.toggle('open');
  });
  speedGroup.querySelectorAll('.speed-opt').forEach((opt) => {
    opt.addEventListener('click', () => {
      const r = parseFloat(opt.dataset.rate);
      controls.setRate(r);
      speedGroup.classList.remove('open'); /* 选完即收 */
    });
  });
  store.subscribe('rate', (s) => {
    speedLabel.textContent = `${s.rate}×`;
    speedGroup.querySelectorAll('.speed-opt').forEach((o) =>
      o.classList.toggle('active', Math.abs(parseFloat(o.dataset.rate) - s.rate) < 0.01));
  });

  /* ---- 更多菜单 ---- */
  const moreBtn = $('#btn-more');
  const morePop = $('#more-popover');
  moreBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    morePop.classList.toggle('open');
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#more-popover, #btn-more')) morePop.classList.remove('open');
    if (!e.target.closest('.speed-group')) speedGroup.classList.remove('open');
    if (!e.target.closest('.volume-group')) volGroup.classList.remove('open');
  });

  $('#mi-shot').addEventListener('click', () => { controls.screenshot(); morePop.classList.remove('open'); });
  $('#mi-sub').addEventListener('click', async () => {
    morePop.classList.remove('open');
    const p = await window.potnext?.openSubtitle();
    if (p) { controls.attachSubtitle(p); toast('字幕已加载'); }
  });
  $('#mi-frame-back').addEventListener('click', () => controls.frameStep(-1));
  $('#mi-frame-fwd').addEventListener('click', () => controls.frameStep(1));
  $('#mi-folder').addEventListener('click', () => {
    morePop.classList.remove('open');
    const item = controls.currentItem();
    if (item) window.potnext?.showItemInFolder(item.path);
  });
  $('#mi-home').addEventListener('click', () => {
    morePop.classList.remove('open');
    window.appActions?.goHome();
  });

  /* ---- 唤出 / 自动隐藏 ----
   * 唤出：鼠标移到窗口下方热区（下方 25%，至少 140px）；
   * 隐藏：鼠标 2 秒不动即隐 —— 任意移动都重置计时（弹层展开 / 按住拖动中除外；
   * 无在播条目时常驻当工具栏用）。 */
  let hideTimer = null;
  let barPointerDown = false;
  const popOpen = () =>
    morePop.classList.contains('open') ||
    speedGroup.classList.contains('open') ||
    volGroup.classList.contains('open');
  const armHide = () => {
    clearTimeout(hideTimer);
    if (!store.get().currentId || popOpen() || barPointerDown) return;
    hideTimer = setTimeout(() => {
      if (store.get().currentId && !popOpen() && !barPointerDown) {
        bar.classList.add('hidden');
      }
    }, 2000);
  };
  const poke = () => {
    bar.classList.remove('hidden');
    armHide();
  };
  window.addEventListener('mousemove', (e) => {
    if (inSummonBand(e.clientY)) poke();           /* 下缘热区：唤出 */
    else if (!bar.classList.contains('hidden')) armHide(); /* 已唤出：任意移动续命 2s */
  });
  /* 点击非舞台元素 = 操作界面，保留播控；舞台下缘热区的单击唤出而不是隐藏 */
  window.addEventListener('click', (e) => {
    if (e.target.closest('#stage-hit') && !inSummonBand(e.clientY)) return;
    poke();
  });
  /* 按住播控栏（拖进度/音量）期间不隐藏 */
  bar.addEventListener('pointerdown', () => { barPointerDown = true; clearTimeout(hideTimer); });
  window.addEventListener('pointerup', () => {
    if (barPointerDown) { barPointerDown = false; armHide(); }
  });
  /* 播放状态/切集只续命不唤出（自动连播换集的 pause/play 不弹播控）；
   * 列表清空 → 回工具栏形态（常驻） */
  store.subscribe('playing', armHide);
  store.subscribe('currentId', (s) => (s.currentId ? armHide() : poke()));

  /* ---- OSD ---- */
  let osdTimer = null;
  window.showOsd = (kind) => {
    const card = $('#osd .osd-card');
    card.querySelector('use').setAttribute('href', kind === 'pause' ? '#i-pause' : '#i-play');
    card.classList.remove('pop');
    void card.offsetWidth;
    card.classList.add('pop');
    clearTimeout(osdTimer);
    osdTimer = setTimeout(() => card.classList.remove('pop'), 700);
  };
}

let volOsdTimer = null;
export function showVolumeOsd() {
  const s = store.get();
  const v = s.muted ? 0 : s.volume;
  const osd = $('#volume-osd');
  osd.querySelector('.vosd-fill').style.width = `${v * 100}%`;
  osd.querySelector('use').setAttribute('href', s.muted || v === 0 ? '#i-mute' : v < 0.5 ? '#i-volume-low' : '#i-volume');
  osd.classList.add('show');
  clearTimeout(volOsdTimer);
  volOsdTimer = setTimeout(() => osd.classList.remove('show'), 1400);
}

/* 轻量 toast 转发（避免循环依赖 store.toast 细节） */
function toast(text) {
  store.set({ toast: { text, kind: 'info' } }, ['toast']);
}
