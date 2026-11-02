/** 自定义标题栏：窗口控制 + 全局按钮状态 */
import { $ } from '../utils/index.js';
import * as store from '../state/store.js';

export function initTitlebar() {
  $('#wc-min')?.addEventListener('click', () => window.potnext?.minimize());
  $('#wc-max')?.addEventListener('click', async () => {
    const maximized = await window.potnext?.maximizeToggle();
    store.set({ maximized }, ['maximized']);
    syncMaxIcon();
  });
  $('#wc-close')?.addEventListener('click', () => window.potnext?.close());

  window.potnext?.onWinState(({ maximized, fullscreen }) => {
    if (maximized != null) store.set({ maximized }, ['maximized']);
    if (fullscreen != null) store.set({ fullscreen }, ['fullscreen']);
    syncMaxIcon();
    $('#app').classList.toggle('fullscreen', !!fullscreen);
  });

  $('#btn-playlist').addEventListener('click', () => {
    store.set({ playlistOpen: !store.get().playlistOpen }, ['playlistOpen']);
  });
  $('#btn-settings').addEventListener('click', () => {
    const view = store.get().view === 'settings' ? 'player' : 'settings';
    store.set({ view }, ['view']);
  });
  $('#btn-back').addEventListener('click', () => window.appActions?.goHome());

  store.subscribe('playlistOpen', (s) => {
    $('#btn-playlist').classList.toggle('on', s.playlistOpen);
  });
  /* 主页 = 浏览器即导航：不显示播放列表按钮；返回按钮只在播放画面出现 */
  const syncHomeBtns = (s) => {
    $('#btn-back').classList.toggle('hidden', s.homeOpen);
    $('#btn-playlist').classList.toggle('hidden', s.homeOpen);
  };
  store.subscribe('homeOpen', syncHomeBtns);
  syncHomeBtns(store.get());
  store.subscribe('view', (s) => {
    $('#btn-settings').classList.toggle('on', s.view === 'settings');
    $('#settings-view').classList.toggle('open', s.view === 'settings');
  });

  syncMaxIcon();
}

function syncMaxIcon() {
  const btn = $('#wc-max use');
  if (!btn) return;
  btn.setAttribute('href', store.get().maximized ? '#i-restore' : '#i-maximize');
}

/** 同步窗口标题（无标题栏，仅更新 document.title 供任务栏/Alt-Tab 显示） */
export function setTitle(text) {
  document.title = text || 'PotNext';
}
