/**
 * 首页纵向浏览器：逐级展开的文件夹导航，直接铺在主页上——
 * 开屏/未在播时不需要先打开播放列表面板（用户交互规范 #1）。
 *
 * 结构（strip = 一行横向滚动条，逐级缩进）：
 *   chips 行（层级 L）   该层可选文件夹（chip 单击展开下一层，再点已选 = 收起）
 *   videos 行（层级 L）  该层文件夹直属视频的预览卡（16:9 缩略图 + 时长角标，单击播放）
 * 选择链 chain[]：chain[L] = 第 L 层选中的文件夹 key；换选同级只影响深层行。
 *
 * 动效（Mineradio 基准，组件级与 .pl-item 同源）：
 *   初始/列表变化：各行逐项级联 hb-item-in 0.22s / 12ms 错峰（上限 16）
 *   展开下一层：  新行整组 hb-strip-in 0.24s expo 滑入（不逐项，避免双重运动）
 *   收起：        瞬时（无退出动画，行数少，退出动画反而拖泥带水）
 */
import { h, $, formatTime } from '../utils/index.js';
import * as store from '../state/store.js';
import { requestThumb, toImgSrc } from '../playback/thumbs.js';

const CHUNK = 30;        // 视频行一次渲染上限，超出走「还有 N 个」
const CASCADE_MAX = 16;  // 逐项级联错峰上限（同播放列表）
const CASCADE_STEP = 12;

/** 相对路径（提示用）：父链 name 反序以 \ 连接 */
function relPathOf(node) {
  const parts = [];
  for (let n = node; n; n = n.parent) parts.push(n.name);
  return parts.reverse().join('\\');
}

/** 逐项级联延迟（仅 cascade 模式调用；超上限关动画防风暴） */
function applyEnter(el, idx) {
  if (idx == null) return;
  if (idx >= CASCADE_MAX) el.style.animation = 'none';
  else el.style.animationDelay = `${idx * CASCADE_STEP}ms`;
}

/* 浏览位置记忆：开屏接着上次下钻的层级（key 失效由 rebuild 剪枝兜底） */
const CHAIN_KEY = 'potnext.home.chain.v1';
function loadChain() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CHAIN_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((k) => typeof k === 'string') : [];
  } catch { return []; }
}

export function initBrowser() {
  const root = $('#home-browser');
  let chain = loadChain(); // [folderKey, ...] 各层选中文件夹

  function saveChain() {
    try { localStorage.setItem(CHAIN_KEY, JSON.stringify(chain)); } catch { /* 降级为仅内存 */ }
  }

  /* ---------- 预览图懒生成（同播放列表：进视口再截帧，缓存路径落盘） ---------- */
  const thumbIO = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      thumbIO.unobserve(en.target);
      const card = en.target;
      const item = store.getPlaylistTree().fileById.get(card.dataset.id)?.item;
      if (!item || item.thumb) continue;
      requestThumb(item.path).then((r) => {
        if (!r?.cachePath) return;
        /* 落盘缓存路径 + 解出的时长（未播条目角标即有真实时长） */
        store.updateItem(item.id, { thumb: r.cachePath, ...(r.duration > 0 ? { duration: r.duration } : {}) });
        paintThumb(card, r.cachePath);
      });
    }
  }, { rootMargin: '300px 240px' });

  function paintThumb(card, cachePath) {
    const thumb = card._thumb;
    if (!thumb || thumb.dataset.k === cachePath) return;
    thumb.dataset.k = cachePath;
    thumb.prepend(h('img', { src: toImgSrc(cachePath), alt: '', draggable: 'false' }));
  }

  /* ---------- 元素构建 ---------- */
  function makeCard(item, enterIdx) {
    const thumb = h('div', { class: 'hb-thumb' },
      h('div', { class: 'hb-dur', text: item.duration > 0 ? formatTime(item.duration) : '' }),
      h('div', { class: 'hb-play' }, h('svg', { class: 'ic' }, h('use', { href: '#i-play' }))));
    const el = h('div', {
      class: `hb-card${item.id === store.get().currentId ? ' now' : ''}`,
      dataset: { id: item.id },
      title: item.path,
      role: 'button',
      tabindex: '0',
      onClick: () => {
        if (store.get().currentId !== item.id) store.set({ currentId: item.id }, ['currentId']);
        else import('../playback/engine.js').then((m) => m.controls.togglePlay());
      },
      onKeydown: (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click(); }
      },
    },
      thumb,
      h('div', { class: 'hb-title', text: item.title }));
    el._thumb = thumb;
    el._dur = thumb.querySelector('.hb-dur');
    applyEnter(el, enterIdx);
    if (item.thumb) paintThumb(el, item.thumb);
    else thumbIO.observe(el);
    return el;
  }

  function makeChip(node, { sel, level, enterIdx }) {
    const el = h('button', {
      class: `hb-chip${sel ? ' sel' : ''}`,
      dataset: { key: node.key },
      title: `${relPathOf(node)} · ${node.count} 个视频`,
      onClick: () => selectAt(level, node.key),
      onDblclick: () => { if (node.firstId) store.set({ currentId: node.firstId }, ['currentId']); },
    },
      h('svg', { class: 'ic' }, h('use', { href: '#i-folder' })),
      h('span', { class: 'hb-chip-name', text: node.name }),
      h('span', { class: 'hb-chip-count', text: String(node.count) }));
    applyEnter(el, enterIdx);
    return el;
  }

  /** 视频行：分块渲染，尾部「还有 N 个」续块（续块不带入场动画） */
  function fillVideos(strip, items, cascade) {
    const renderMore = (count) => {
      strip._more?.remove();
      const start = strip._rendered ?? 0;
      for (const [i, item] of items.slice(start, start + count).entries()) {
        strip.append(makeCard(item, cascade ? start + i : null));
      }
      strip._rendered = start + Math.min(count, items.length - start);
      if (strip._rendered < items.length) {
        const more = h('button', {
          class: 'hb-more',
          text: `还有 ${items.length - strip._rendered} 个`,
          onClick: () => renderMore(CHUNK),
        });
        strip._more = more;
        strip.append(more);
      }
    };
    renderMore(CHUNK);
  }

  /* ---------- 选择与重建 ---------- */
  function selectAt(level, key) {
    if (chain[level] === key) {
      chain.length = level;   /* 再点已选：收起下级（瞬时） */
      saveChain();
      rebuild({});
      return;
    }
    chain = chain.slice(0, level + 1);
    chain[level] = key;
    saveChain();
    /* 新增层级整行滑入 */
    rebuild({ unfoldFrom: level + 1 });
  }

  /** 按名字逐层定位（includes 模糊匹配）并展开 —— dev --eval 自动化探针入口 */
  function setChainByNames(names) {
    const tree = store.getPlaylistTree();
    let nodes = tree.roots;
    const keys = [];
    for (const name of names || []) {
      const node = nodes.find((n) => n.type === 'folder' && n.name.includes(name));
      if (!node) break;
      keys.push(node.key);
      nodes = node.children;
    }
    if (!keys.length) return false;
    chain = keys;
    saveChain();
    rebuild({ cascade: true });
    return true;
  }

  /** cascade：逐项级联（初始/列表变化）；unfoldFrom：该层级起整行滑入（展开下一层） */
  function rebuild({ cascade = false, unfoldFrom = Infinity } = {}) {
    const tree = store.getPlaylistTree();
    /* 选择链剪枝：文件夹被移除时截断（保证 prefix 语义，不跳层） */
    for (let i = 0; i < chain.length; i += 1) {
      if (!tree.nodeByKey.has(chain[i])) { chain.length = i; break; }
    }

    thumbIO.disconnect();
    root.replaceChildren();
    if (!store.get().playlist.length) {
      root.classList.add('hidden');
      return;
    }
    root.classList.remove('hidden');

    const stripFor = (kind, level) => h('div', {
      class: `hb-strip ${kind}${cascade ? ' enter' : ''}${level >= unfoldFrom ? ' unfold' : ''}`,
      dataset: { level: String(level) },
    });

    const frag = document.createDocumentFragment();

    /* 层 0：根文件夹 chips（+ 根散文件视频行，跨盘/散文件场景） */
    const roots = tree.roots;
    const lv0 = stripFor('chips', 0);
    let i = 0;
    for (const n of roots) {
      if (n.type !== 'folder') continue;
      lv0.append(makeChip(n, { sel: chain[0] === n.key, level: 0, enterIdx: cascade ? i : null }));
      i += 1;
    }
    if (lv0.childElementCount) frag.append(lv0);
    const rootFiles = roots.filter((n) => n.type === 'file');
    if (rootFiles.length) {
      const vs = stripFor('videos', 0);
      fillVideos(vs, rootFiles.map((n) => n.item), cascade);
      frag.append(vs);
    }

    /* 选中链逐层：子文件夹 chips 行 + 直属视频行 */
    for (let L = 0; L < chain.length; L += 1) {
      const node = tree.nodeByKey.get(chain[L]);
      const cascadeHere = cascade;
      const sub = node.children.filter((n) => n.type === 'folder');
      const files = node.children.filter((n) => n.type === 'file');
      if (sub.length) {
        const cs = stripFor('chips', L + 1);
        sub.forEach((n, j) => cs.append(makeChip(n, {
          sel: chain[L + 1] === n.key, level: L + 1, enterIdx: cascadeHere ? j : null,
        })));
        frag.append(cs);
      }
      if (files.length) {
        const vs = stripFor('videos', L + 1);
        fillVideos(vs, files.map((n) => n.item), cascadeHere);
        frag.append(vs);
      }
    }

    root.append(frag);
  }

  /* ---------- 事件订阅 ---------- */
  function markNow() {
    const id = store.get().currentId;
    for (const el of root.querySelectorAll('.hb-card')) {
      el.classList.toggle('now', el.dataset.id === id);
    }
  }

  function refreshMeta() {
    const tree = store.getPlaylistTree();
    for (const el of root.querySelectorAll('.hb-card')) {
      const item = tree.fileById.get(el.dataset.id)?.item;
      if (!item || !el._dur) continue;
      const t = item.duration > 0 ? formatTime(item.duration) : '';
      if (el._dur.textContent !== t) el._dur.textContent = t;
    }
  }

  store.subscribe('playlist', () => rebuild({ cascade: true }));
  store.subscribe('currentId', markNow);
  store.subscribe('playlistMeta', refreshMeta);

  rebuild({ cascade: true });
  return { setChainByNames };
}
