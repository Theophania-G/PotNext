/** DOM 工具：创建元素、事件、节流 */
const SVG_NS = 'http://www.w3.org/2000/svg';
const SVG_TAGS = new Set(['svg', 'use', 'path', 'circle', 'rect', 'line', 'g', 'defs', 'symbol', 'polyline', 'polygon', 'ellipse']);

export function h(tag, attrs = {}, ...children) {
  /* svg 系标签必须走 createElementNS，HTML 命名空间下的 <svg> 不渲染 */
  const isSvg = SVG_TAGS.has(tag);
  const el = isSvg ? document.createElementNS(SVG_NS, tag) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') isSvg ? el.setAttribute('class', v) : (el.className = v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function on(el, ev, fn, opts) {
  el.addEventListener(ev, fn, opts);
  return () => el.removeEventListener(ev, fn, opts);
}

/** 指针拖拽（鼠标+触屏通用）：返回解绑函数 */
export function draggable(el, { onStart, onMove, onEnd } = {}) {
  const move = (e) => onMove?.(e);
  const up = (e) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    onEnd?.(e);
  };
  const down = (e) => {
    if (e.button != null && e.button !== 0) return;
    e.preventDefault();
    onStart?.(e);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };
  el.addEventListener('pointerdown', down);
  return () => el.removeEventListener('pointerdown', down);
}

export function raf(fn) {
  let id = 0, last = 0, pending = false, lastArgs = null;
  const loop = (t) => {
    pending = false;
    if (t - last >= 14) { last = t; fn(...lastArgs); }
    else if (!pending) { pending = true; id = requestAnimationFrame(loop); }
  };
  return (...args) => { lastArgs = args; if (!pending) { pending = true; id = requestAnimationFrame(loop); } };
}

export function throttle(fn, ms) {
  let last = 0, timer = null, lastArgs = null;
  return (...args) => {
    const now = performance.now();
    lastArgs = args;
    if (now - last >= ms) { last = now; fn(...args); }
    else if (!timer) {
      timer = setTimeout(() => { timer = null; last = performance.now(); fn(...lastArgs); }, ms - (now - last));
    }
  };
}
