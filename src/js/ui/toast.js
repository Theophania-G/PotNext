/** Toast：轻量全局提示 */
import { h, $ } from '../utils/index.js';
import * as store from '../state/store.js';

const ICON = { success: '#i-check', error: '#i-close', info: '#i-more' };

export function initToast() {
  const wrap = $('#toast-wrap');
  let lastText = {};

  store.subscribe('toast', (s) => {
    const t = s.toast;
    if (!t) return;
    /* 去抖：同文本 1s 内不重复 */
    const now = Date.now();
    if (t.text === lastText.text && now - lastText.at < 1200) return;
    lastText = { text: t.text, at: now };

    const el = h('div', { class: `toast ${t.kind || 'info'}` },
      h('svg', { class: 'ic' }, h('use', { href: ICON[t.kind] || ICON.info })),
      h('span', { text: t.text }),
    );
    wrap.append(el);
    setTimeout(() => {
      el.classList.add('out');
      el.addEventListener('animationend', () => el.remove(), { once: true });
    }, 2600);
  });
}

export function toast(text, kind = 'info') {
  store.set({ toast: { text, kind } }, ['toast']);
}
