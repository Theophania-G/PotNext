/**
 * PotNext — 应用入口
 * 装配：store 水合 → 播放引擎挂载 → UI 组件初始化 → 系统集成（拖放/文件）。
 */
import { $, baseName, extOf, formatTime } from './utils/index.js';
import * as store from './state/store.js';
import { attach as attachEngine, makeItems, controls } from './playback/engine.js';
import { initTitlebar, setTitle } from './ui/titlebar.js';
import { initControls, inSummonBand } from './ui/controls.js';
import { initTimeline } from './ui/timeline.js';
import { initPlaylist } from './ui/playlist.js';
import { initBrowser } from './ui/browser.js';
import { initSettings } from './ui/settings.js';
import { initToast, toast } from './ui/toast.js';
import { initShortcuts } from './ui/shortcuts.js';
import { requestThumb, toImgSrc } from './playback/thumbs.js';

async function main() {
  await store.hydrate();

  attachEngine($('#video'));
  initTitlebar();
  initControls();
  initTimeline();
  initPlaylist();
  const browserApi = initBrowser();
  initSettings();
  initToast();
  initShortcuts();

  wireFiles();
  window.appActions.browseChainByNames = browserApi.setChainByNames;
  wireEmptyState();
  wireNowPlaying();
  wireStage();

  const v = await window.potnext?.version?.();
  if (v) console.log(`PotNext v${v}`);
}

/* ---------- 文件接入（对话框 + 拖放） ---------- */
function wireFiles() {
  window.appActions = {
    async openMedia() {
      const paths = await window.potnext?.openMedia();
      if (paths?.length) addAndMaybePlay(paths, { play: true });
    },
    async openFolder() {
      const dir = await window.potnext?.openFolder();
      if (!dir) return;
      const paths = await window.potnext?.scanFolder(dir);
      if (paths?.length) {
        addAndMaybePlay(paths, { play: false });
        toast(`已添加 ${paths.length} 个文件`);
      } else {
        toast('文件夹中没有媒体文件');
      }
    },
    /* 返回主页：暂停保留进度，铺回纵向浏览器（当前条目仍带 .now，再点续播）；
       顺手收起列表面板 —— 主页即导航，不带播放画面的浮层回来 */
    goHome() {
      const v = $('#video');
      if (v && !v.paused) v.pause();
      const s = store.get();
      if (s.homeOpen && !s.playlistOpen) return;
      store.set({ homeOpen: true, playlistOpen: false }, ['homeOpen', 'playlistOpen']);
    },
  };

  /* 打开文件 = 直接开播；导入文件夹 = 回主页逐级挑（不自动播） */
  const addAndMaybePlay = (paths, { play }) => {
    const items = makeItems(paths);
    if (!items.length) return;
    store.addToPlaylist(items, { play });
  };

  /* 拖放 */
  const veil = $('#drop-veil');
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    if (++dragDepth === 1) veil.classList.add('show');
  });
  window.addEventListener('dragleave', (e) => {
    e.preventDefault();
    if (--dragDepth <= 0) { dragDepth = 0; veil.classList.remove('show'); }
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    veil.classList.remove('show');
    const paths = [...(e.dataTransfer?.files || [])]
      .map((f) => window.potnext?.filePathOf(f))
      .filter(Boolean);
    const dirs = [];
    const files = [];
    for (const p of paths) {
      /* Windows 无扩展名多半是目录，交给主进程扫描 */
      if (!/\.[^.\\/]+$/.test(p)) dirs.push(p); else files.push(p);
    }
    if (files.length) addAndMaybePlay(files, { play: true });
    for (const d of dirs) {
      const scanned = await window.potnext?.scanFolder(d);
      if (scanned?.length) addAndMaybePlay(scanned, { play: false });
    }
  });
}

/* ---------- 空状态 / 主页纵向浏览器：homeOpen 独立于 currentId ----------
 * 开始播放（play 事件，含点卡/续播/上一曲下一曲）即切到画面；
 * 返回 = goHome（暂停保留进度回主页）。 */
function wireEmptyState() {
  const empty = $('#empty-state');
  const sub = empty.querySelector('.empty-sub');

  const paint = (s) => {
    const hasItems = s.playlist.length > 0;
    empty.classList.toggle('hidden', !s.homeOpen);
    empty.classList.toggle('has-items', hasItems);
    if (!hasItems) sub.textContent = '拖入视频开始播放，或打开文件 / 文件夹';
  };
  store.subscribe('homeOpen', paint);
  store.subscribe('playlist', paint);
  paint(store.get());

  $('#video').addEventListener('play', () => {
    if (store.get().homeOpen) store.set({ homeOpen: false }, ['homeOpen']);
  });
}

/* ---------- 画面交互 ----------
 * 单击：隐藏播控栏 + 列表栏（下缘热区内单击 = 唤出播控，不是隐藏）
 * 双击：全屏切换
 * 滚轮：音量
 * 鼠标移到下方热区：唤出播控栏；贴近右缘：唤出列表栏 */
function wireStage() {
  const hit = $('#stage-hit');
  const panel = $('#playlist-panel');
  const bar = $('#control-bar');
  let lastClick = 0;

  hit.addEventListener('click', (e) => {
    /* 延迟区分单/双击 */
    const now = Date.now();
    if (now - lastClick < 280) return;
    lastClick = now;
    setTimeout(() => {
      if (Date.now() - lastClick >= 280) {
        /* 下缘热区的单击留给「唤出播控」（controls 的 click-poke），
         * 防止播控隐身时误点穿透把列表也关掉 */
        if (inSummonBand(e.clientY)) return;
        bar.classList.add('hidden');
        store.set({ playlistOpen: false }, ['playlistOpen']);
      }
    }, 290);
  });

  hit.addEventListener('dblclick', () => {
    lastClick = Date.now();
    window.potnext?.fullscreenToggle();
  });

  hit.addEventListener('wheel', (e) => {
    e.preventDefault();
    const s = store.get();
    controls.setVolume((s.muted ? 0 : s.volume) + (e.deltaY < 0 ? 0.04 : -0.04));
  }, { passive: false });

  /* 右缘热区唤出列表栏：只负责「唤出」；收起交给单击画面 / B 键 / 按钮。
     主页不响应：纵向浏览器本身就是列表，鼠标滑过右缘不该再弹面板 */
  const EDGE = 24;
  window.addEventListener('mousemove', (e) => {
    const inPanel = (e.target instanceof Node && panel.contains(e.target)) || panel.matches(':hover');
    if (inPanel) return;
    if (store.get().homeOpen) return;
    if (e.clientX >= window.innerWidth - EDGE && !store.get().playlistOpen) {
      store.set({ playlistOpen: true }, ['playlistOpen']);
    }
  });
}

/* ---------- 正在播放信息 ---------- */
function wireNowPlaying() {
  const thumbEl = $('#now-thumb');
  const paint = (s) => {
    const item = s.playlist.find((i) => i.id === s.currentId);
    $('#now-title').textContent = item ? item.title : '未在播放';
    $('#now-sub').textContent = item
      ? `${item.ext?.toUpperCase() || '媒体'} · ${formatTime(item.duration)}`
      : '打开或拖入媒体文件';
    setTitle(item ? `${item.title} — PotNext` : 'PotNext');
    paintThumbInto(thumbEl, item);
    /* 无缓存预览图的在播条目：主动生成一次 */
    if (item && !item.thumb) {
      requestThumb(item.path).then((r) => {
        if (r?.cachePath) {
          store.updateItem(item.id, { thumb: r.cachePath, ...(r.duration > 0 ? { duration: r.duration } : {}) });
        }
      });
    }
  };
  store.subscribe('currentId', paint);
  store.subscribe('playlist', paint);
  store.subscribe('playlistMeta', paint); /* 元数据（时长/标题）刷新 */
  paint(store.get());
}

/** 控制栏 44px 封面：有预览图贴图，无则回退占位图标 */
function paintThumbInto(thumbEl, item) {
  if (!thumbEl) return;
  const img = thumbEl.querySelector('img');
  const k = item?.thumb || null;
  if (!k) {
    img?.remove();
    thumbEl.classList.remove('has-thumb');
    return;
  }
  if (img?.dataset.k === k) return;
  if (img) img.remove();
  const el = document.createElement('img');
  el.src = toImgSrc(k);
  el.dataset.k = k;
  el.alt = '';
  thumbEl.prepend(el);
  thumbEl.classList.add('has-thumb');
}

main();
