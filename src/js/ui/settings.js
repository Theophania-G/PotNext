/** 设置视图：外观 / 播放偏好 */
import { $, $$ } from '../utils/index.js';
import * as store from '../state/store.js';

export function initSettings() {
  const root = document.documentElement;

  const applyTheme = (s) => {
    root.dataset.theme = s.settings.theme;
    root.dataset.accent = s.settings.accent;
  };
  store.subscribe('settings', applyTheme);
  applyTheme(store.get());

  $('#settings-close').addEventListener('click', () => store.set({ view: 'player' }, ['view']));
  $('#settings-view').addEventListener('click', (e) => {
    if (e.target === $('#settings-view')) store.set({ view: 'player' }, ['view']);
  });

  /* 主题分段 */
  bindSeg('#seg-theme', 'theme');
  /* 强调色 */
  bindSwatches('#sw-accent', 'accent');
  /* 开关 */
  bindToggle('#tg-autonext', 'autoPlayNext');
  bindToggle('#tg-remember', 'rememberPosition');
  bindToggle('#tg-subs', 'showSubtitles', (on) => {
    import('../playback/engine.js').then((m) => m.controls.toggleSubtitles(on));
  });

  function bindSeg(sel, key) {
    const seg = $(sel);
    const sync = (s) => seg.querySelectorAll('button').forEach((b) =>
      b.classList.toggle('active', b.dataset.val === s.settings[key]));
    seg.querySelectorAll('button').forEach((b) =>
      b.addEventListener('click', () => { store.setSetting(key, b.dataset.val); }));
    store.subscribe('settings', sync);
    sync(store.get());
  }

  function bindSwatches(sel, key) {
    const box = $(sel);
    const sync = (s) => box.querySelectorAll('.sw').forEach((b) =>
      b.classList.toggle('active', b.dataset.val === s.settings[key]));
    box.querySelectorAll('.sw').forEach((b) =>
      b.addEventListener('click', () => { store.setSetting(key, b.dataset.val); }));
    store.subscribe('settings', sync);
    sync(store.get());
  }

  function bindToggle(sel, key, after) {
    const btn = $(sel);
    const sync = (s) => btn.classList.toggle('active', !!s.settings[key]);
    btn.addEventListener('click', () => {
      const on = !store.get().settings[key];
      store.setSetting(key, on);
      after?.(on);
    });
    store.subscribe('settings', sync);
    sync(store.get());
  }
}
