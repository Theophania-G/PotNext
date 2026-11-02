/**
 * 键盘快捷键：全局统一注册，输入框聚焦时自动放行。
 */
import * as store from '../state/store.js';
import { controls } from '../playback/engine.js';

const actions = {
  togglePlay: () => controls.togglePlay(),
  seekSmallFwd: () => controls.seekBy(store.get().settings.seekStepSmall),
  seekSmallBack: () => controls.seekBy(-store.get().settings.seekStepSmall),
  seekLargeFwd: () => controls.seekBy(store.get().settings.seekStepLarge),
  seekLargeBack: () => controls.seekBy(-store.get().settings.seekStepLarge),
  volumeUp: () => controls.setVolume((store.get().muted ? 0 : store.get().volume) + 0.05),
  volumeDown: () => controls.setVolume((store.get().muted ? 0 : store.get().volume) - 0.05),
  toggleMute: () => controls.toggleMute(),
  fullscreen: () => window.potnext?.fullscreenToggle(),
  next: () => store.stepTrack(1),
  prev: () => {
    /* 播放超过 3 秒时先回到开头（常见播放器习惯） */
    if (store.get().currentTime > 3) controls.seek(0);
    else store.stepTrack(-1);
  },
  /* 主页即导航：列表面板只属于播放画面，B 键在主页不响应 */
  togglePlaylist: () => {
    if (store.get().homeOpen) return;
    store.set({ playlistOpen: !store.get().playlistOpen }, ['playlistOpen']);
  },
  screenshot: () => controls.screenshot(),
  frameBack: () => controls.frameStep(-1),
  frameFwd: () => controls.frameStep(1),
  speedDown: () => {
    const steps = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 3];
    const cur = store.get().rate;
    const i = steps.findIndex((s) => s > cur + 0.01);
    controls.setRate(i < 0 ? steps[steps.length - 1] : steps[i]);
  },
  speedUp: () => {
    const steps = [3, 2, 1.75, 1.5, 1.25, 1, 0.75, 0.5, 0.25];
    const cur = store.get().rate;
    const i = steps.findIndex((s) => s < cur - 0.01);
    controls.setRate(i < 0 ? steps[steps.length - 1] : steps[i]);
  },
  speedReset: () => controls.setRate(1),
  settings: () => store.set({ view: store.get().view === 'settings' ? 'player' : 'settings' }, ['view']),
  /* Esc 逐层退出：设置 → 列表面板 → 全屏 → 返回主页 */
  escape: () => {
    const s = store.get();
    if (s.view === 'settings') { store.set({ view: 'player' }, ['view']); return; }
    if (s.playlistOpen) { store.set({ playlistOpen: false }, ['playlistOpen']); return; }
    if (s.fullscreen) { window.potnext?.fullscreenToggle(); return; }
    if (!s.homeOpen) window.appActions?.goHome();
  },
  openFile: () => window.appActions?.openMedia(),
  openFolder: () => window.appActions?.openFolder(),
};

const map = {
  ' ': 'togglePlay',
  'k': 'togglePlay',
  'ArrowRight': 'seekSmallFwd',
  'ArrowLeft': 'seekSmallBack',
  'j': 'seekLargeBack',
  'l': 'seekLargeFwd',
  'ArrowUp': 'volumeUp',
  'ArrowDown': 'volumeDown',
  'm': 'toggleMute',
  'f': 'fullscreen',
  'F11': 'fullscreen',
  'n': 'next',
  'p': 'prev',
  'b': 'togglePlaylist',
  's': 'screenshot',
  ',': 'frameBack',
  '.': 'frameFwd',
  '[': 'speedDown',
  ']': 'speedUp',
  '\\': 'speedReset',
  'o': 'openFile',
  'Ctrl+o': 'openFile',
  'Ctrl+Shift+O': 'openFolder',
  'Ctrl+Shift+o': 'openFolder',
  'Ctrl+,': 'settings',
  'Escape': 'escape',
};

export function initShortcuts() {
  /* 按住 → = 2× 倍速（PotPlayer 习惯）；轻点 → 仍是快进 5s。
   * 用延时定时器区分：按下超过 TAP_MS 才进入加速，松手还原；短按走原 seek。 */
  const TAP_MS = 240;
  let boostTimer = null;
  let boostActive = false;
  let rateBeforeBoost = 1;

  const boostOn = () => {
    if (boostActive) return;
    boostActive = true;
    rateBeforeBoost = store.get().rate;
    controls.setRate(2);
  };
  const boostOff = (e) => {
    clearTimeout(boostTimer);
    boostTimer = null;
    if (boostActive) {
      boostActive = false;
      controls.setRate(rateBeforeBoost);
    } else if (e?.type === 'keyup') {
      /* 轻点（未进入加速）→ 快进 5s */
      actions.seekSmallFwd();
    }
  };

  window.addEventListener('keydown', (e) => {
    const tag = e.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable) return;

    /* 长按 →：延时进入 2× 加速，屏蔽系统连发 */
    if (e.key === 'ArrowRight' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      if (!e.repeat && !boostActive && !boostTimer) {
        boostTimer = setTimeout(() => { boostTimer = null; boostOn(); }, TAP_MS);
      }
      return;
    }
    const key = [];
    if (e.ctrlKey || e.metaKey) key.push('Ctrl');
    if (e.shiftKey) key.push('Shift');
    if (e.altKey) key.push('Alt');
    key.push(e.key === ' ' ? ' ' : e.key);
    const combo = key.join('+');
    const action = map[combo] || map[e.key];
    if (!action || !actions[action]) return;

    /* 系统连发：仅 seek / 音量保留（长按连续快退、调音量），
     * 其余动作屏蔽 repeat 防止连触发（如播放/暂停抖动） */
    const REPEATABLE = new Set(['seekSmallBack', 'seekLargeFwd', 'seekLargeBack', 'volumeUp', 'volumeDown']);
    if (e.repeat && !REPEATABLE.has(action)) return;

    e.preventDefault();
    actions[action]();
  });

  window.addEventListener('keyup', (e) => {
    if (e.key === 'ArrowRight') boostOff(e);
  });
  /* 失焦兜底还原（按住时切窗口不会卡在 2×） */
  window.addEventListener('blur', () => boostOff());
}

export { actions };
