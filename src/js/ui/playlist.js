/**
 * 播放列表面板：文件夹层级树（子文件夹嵌套缩进）+ 62px 文件行。
 *
 * 事件矩阵（与 store 契约一致）：
 *   'playlist'      全量重建可见行（无动画，存复 scrollTop）
 *   'plExpanded'    与上次快照 diff —— 恰好一键新增：重建且仅新行 item-in 级联、chevron 走 .open 过渡；
 *                   恰好一键移除：先 .collapsing 0.14s 淡出后重建；多键或初次：直接重建无动画
 *   'currentId'     快路径不重建：.now / 封面图标 / 祖先链迁移、expandFolders(祖先链)、滚动落位
 *   'playlistMeta'  仅刷 .pi-dur 与标题文本（树缓存不置脏）
 *   'playlistOpen'  面板打开时重建 + 入场级联
 *
 * 树为渲染期纯派生视图（store.getPlaylistTree()），持久化仍是扁平数组。
 */
import { h, $, formatTime } from '../utils/index.js';
import * as store from '../state/store.js';
import { toast } from './toast.js';
import { requestThumb, toImgSrc } from '../playback/thumbs.js';

const CASCADE_MAX = 16;      // 错峰上限：前 16 行级联，第 17 行起 animation:none
const CASCADE_STEP = 12;     // 错峰间隔 12ms
const COLLAPSE_MS = 180;     // 折叠移除延迟：对齐 chevron 0.18s 旋转（淡出 0.14s forwards 不受影响）
const COLLAPSE_ANIM_MAX = 120; // 折叠动画行数上限，超出瞬时隐藏防动画风暴
const FLIP_MAX = 80;         // FLIP 落位动画行数上限（超出视为批量操作直接跳变）

/* ---------- 纯工具 ---------- */

/** 相对路径（LCP 根下完整路径）：父链 name 反序以 \ 连接 */
function relPathOf(node) {
  const parts = [];
  for (let n = node; n; n = n.parent) parts.push(n.name);
  return parts.reverse().join('\\');
}

/** 当前项祖先文件夹 key 集合 */
function ancestorKeysOf(tree, id) {
  const keys = new Set();
  for (let n = tree.fileById.get(id)?.parent; n; n = n.parent) keys.add(n.key);
  return keys;
}

/** 盘符根行（跨盘符多来源时出现）：盘根短样式 */
function isDriveRoot(node) {
  return !node.parent && /^[A-Za-z]:$/.test(node.name);
}

/** 可见行 token 集合（f:文件夹key / i:文件id），DFS 跳过未展开子树 */
function computeVisibleTokens(tree, expanded) {
  const out = new Set();
  const walk = (nodes) => {
    for (const n of nodes) {
      if (n.type === 'folder') {
        out.add(`f:${n.key}`);
        if (expanded.has(n.key)) walk(n.children);
      } else {
        out.add(`i:${n.item.id}`);
      }
    }
  };
  walk(tree.roots);
  return out;
}

/** 入场级联：idx 小于上限给 12ms 错峰延迟，其余关闭动画 */
function applyAnim(el, idx) {
  if (idx == null || idx >= CASCADE_MAX) el.style.animation = 'none';
  else el.style.animationDelay = `${idx * CASCADE_STEP}ms`;
}

export function initPlaylist() {
  const panel = $('#playlist-panel');
  const list = $('#pl-list');

  /* 渲染期索引（仅可见行） */
  const rowById = new Map();   // item.id -> .pl-item
  const rowByKey = new Map();  // folder key -> .pl-folder
  let visibleRows = new Map(); // token -> row el（上次可见快照，供 diff）
  let lastExpanded = new Set();
  let hasSnap = false;
  let collapseTimer = null;
  let dragId = null;

  /* ---------- 预览图懒生成 ---------- */
  const thumbIO = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      thumbIO.unobserve(en.target);
      const rowEl = en.target;
      const item = store.getPlaylistTree().fileById.get(rowEl.dataset.id)?.item;
      if (!item || item.thumb) continue;
      requestThumb(item.path).then((r) => {
        if (!r?.cachePath) return;
        store.updateItem(item.id, { thumb: r.cachePath, ...(r.duration > 0 ? { duration: r.duration } : {}) });
        paintThumb(rowEl, r.cachePath);
      });
    }
  }, { root: list, rootMargin: '200px 0px' });

  /** 预览图贴进封面。
   * 不检查 isConnected：创建行时的直贴调用发生在挂载前（isConnected 必假），
   * 早退会让「重启后已有缓存」的条目永远没图、也不再进懒生成。重建后的孤儿行贴图无害。 */
  function paintThumb(rowEl, cachePath) {
    const cover = rowEl._cover;
    if (!cover || cover.dataset.thumb === cachePath) return;
    cover.dataset.thumb = cachePath;
    cover.prepend(h('img', { class: 'pi-thumb', src: toImgSrc(cachePath), alt: '', draggable: 'false' }));
    cover.classList.add('has-thumb');
  }

  /* ---------- 同帧合并重建：多事件连发只重建一次 ---------- */
  const MODE_RANK = { none: 0, 'diff-cascade': 1, cascade: 2 };
  let mergeRaf = 0;
  let mergeOpts = null;
  function queueRebuild(opts = {}) {
    const prev = mergeOpts || {};
    mergeOpts = {
      mode: (MODE_RANK[opts.mode] ?? 0) >= (MODE_RANK[prev.mode] ?? 0) ? (opts.mode ?? 'none') : prev.mode,
      openAnimKey: opts.openAnimKey ?? prev.openAnimKey ?? null,
      scrollToNow: !!(opts.scrollToNow || prev.scrollToNow),
      flip: !!(opts.flip || prev.flip),
    };
    if (mergeRaf) return;
    mergeRaf = requestAnimationFrame(() => {
      mergeRaf = 0;
      const o = mergeOpts;
      mergeOpts = null;
      rebuild(o);
    });
  }

  /* ---------- 面板开合 ---------- */
  store.subscribe('playlistOpen', (s) => {
    panel.classList.toggle('open', s.playlistOpen);
    if (s.playlistOpen) queueRebuild({ mode: 'cascade', scrollToNow: true });
  });
  panel.classList.toggle('open', store.get().playlistOpen);

  /* ---------- 事件矩阵 ---------- */
  store.subscribe('playlist', () => queueRebuild({ mode: 'none' }));
  store.subscribe('plExpanded', onExpanded);
  store.subscribe('currentId', onCurrentId);
  store.subscribe('playlistMeta', onMeta);

  /* ---------- 顶部操作 ---------- */
  $('#pl-add-file').addEventListener('click', () => window.appActions?.openMedia());
  $('#pl-add-folder').addEventListener('click', () => window.appActions?.openFolder());
  $('#pl-clear').addEventListener('click', () => {
    if (store.get().playlist.length) {
      store.clearPlaylist();
      toast('播放列表已清空');
    }
  });
  $('#pl-expand-all').addEventListener('click', () => {
    const s = store.get();
    const keys = store.getPlaylistTree().folders.map((f) => f.key);
    const allOpen = keys.length > 0 && keys.every((k) => s.plExpanded.has(k));
    if (allOpen) store.collapseAll();
    else store.expandFolders(keys);
  });

  /* 展开全部 / 折叠全部 二态 tooltip */
  function syncExpandBtn() {
    const btn = $('#pl-expand-all');
    if (!btn) return;
    const s = store.get();
    const keys = store.getPlaylistTree().folders.map((f) => f.key);
    const allOpen = keys.length > 0 && keys.every((k) => s.plExpanded.has(k));
    btn.dataset.tip = allOpen ? '折叠全部' : '展开全部';
    btn.setAttribute('aria-label', allOpen ? '折叠全部' : '展开全部');
  }

  /* ---------- plExpanded：快照 diff ---------- */
  function onExpanded() {
    const s = store.get();
    const now = new Set(s.plExpanded);
    const added = [];
    const removed = [];
    for (const k of now) if (!lastExpanded.has(k)) added.push(k);
    for (const k of lastExpanded) if (!now.has(k)) removed.push(k);
    lastExpanded = now;

    if (hasSnap && added.length === 1 && !removed.length) {
      /* 单键展开：重建，仅子树新行级联，chevron 走 .open 过渡；下方行 FLIP 滑入 */
      queueRebuild({ mode: 'diff-cascade', openAnimKey: added[0], flip: true });
      return;
    }
    if (hasSnap && removed.length === 1 && !added.length) {
      /* 单键折叠：消失行 0.14s 淡出后重建 */
      collapseOne(removed[0]);
      return;
    }
    /* 多键 / 初次：直接重建无动画（展开全部、祖先链批量展开等） */
    queueRebuild({ mode: 'none' });
  }

  function collapseOne(key) {
    const s = store.get();
    const keep = computeVisibleTokens(store.getPlaylistTree(), s.plExpanded);
    rowByKey.get(key)?.classList.remove('open'); /* chevron 0.18s 转回 */
    let animCount = 0;
    for (const [token, el] of visibleRows) {
      if (keep.has(token)) continue;
      el.style.animation = '';
      el.style.animationDelay = '';
      if (++animCount <= COLLAPSE_ANIM_MAX) el.classList.add('collapsing');
      else el.style.opacity = '0'; /* 超上限瞬时隐藏，避免数百行动画风暴 */
    }
    if (collapseTimer) clearTimeout(collapseTimer);
    collapseTimer = setTimeout(() => {
      collapseTimer = null;
      queueRebuild({ mode: 'none', flip: true }); /* FLIP 平滑下方行上移 */
    }, COLLAPSE_MS);
  }

  /* ---------- currentId：快路径 ---------- */
  function onCurrentId() {
    const s = store.get();
    const tree = store.getPlaylistTree();
    const chain = [];
    for (let n = tree.fileById.get(s.currentId)?.parent; n; n = n.parent) chain.push(n.key);
    const need = chain.filter((k) => !s.plExpanded.has(k));
    if (need.length) store.expandFolders(need); /* → plExpanded 重建（自动标注 .now/.ancestor） */
    else migrateNow();

    requestAnimationFrame(() => {
      rowById.get(store.get().currentId)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }

  /** 不重建：迁移 .now / 封面图标 / 祖先链类（引导线换强调色由 CSS 跟随） */
  function migrateNow() {
    const s = store.get();
    const tree = store.getPlaylistTree();
    for (const [id, el] of rowById) {
      const isNow = id === s.currentId;
      if (el.classList.contains('now') === isNow) continue;
      el.classList.toggle('now', isNow);
      el._coverUse?.setAttribute('href', isNow ? '#i-pause' : '#i-play');
      if (isNow) {
        const item = tree.fileById.get(id)?.item;
        const durText = item && item.duration > 0 ? formatTime(item.duration) : '';
        if (el._dur && el._dur.textContent !== durText) el._dur.textContent = durText;
      }
    }
    const ancKeys = ancestorKeysOf(tree, s.currentId);
    for (const [key, el] of rowByKey) {
      const on = ancKeys.has(key);
      if (el.classList.contains('ancestor') !== on) el.classList.toggle('ancestor', on);
    }
  }

  /* ---------- playlistMeta：仅刷时长与标题（缓存行内引用，值不变不写） ---------- */
  function onMeta() {
    const tree = store.getPlaylistTree();
    for (const [id, el] of rowById) {
      const item = tree.fileById.get(id)?.item;
      if (!item) continue;
      const durText = item.duration > 0 ? formatTime(item.duration) : '';
      if (el._dur && el._dur.textContent !== durText) el._dur.textContent = durText;
      if (el._name && el._name.textContent !== item.title) {
        el._name.textContent = item.title;
        el._name.title = item.path;
      }
    }
  }

  /* ---------- 行构建 ---------- */
  function makeFileRow(node, { isNow }) {
    const item = node.item;
    const cover = h('div', { class: 'pi-cover' },
      h('svg', { class: 'ic' }, h('use', { href: isNow ? '#i-pause' : '#i-play' })));
    const nameEl = h('div', { class: 'pi-name', text: item.title, title: item.path });
    const durEl = h('div', { class: 'pi-dur', text: item.duration > 0 ? formatTime(item.duration) : '' });
    const el = h('div', {
      class: `pl-item${isNow ? ' now' : ''}`,
      dataset: { id: item.id },
      draggable: 'true',
    },
      cover,
      h('div', { class: 'pi-info' },
        nameEl,
        h('div', { class: 'pi-sub', text: item.ext?.toUpperCase() || '' }),
      ),
      /* .pi-dur 与 .pi-acts 同时渲染，由 .now 类 CSS 切换显隐 */
      durEl,
      h('div', { class: 'pi-acts' },
        h('button', {
          class: 'pi-btn danger', title: '移除',
          onClick: (e) => { e.stopPropagation(); store.removeFromPlaylist([item.id]); },
        }, h('svg', { class: 'ic' }, h('use', { href: '#i-trash' }))),
      ),
    );
    el._cover = cover;
    el._coverUse = cover.querySelector('use');
    el._name = nameEl;
    el._dur = durEl;
    /* 预览图：有缓存直接贴，无缓存等行进视口再懒生成 */
    if (item.thumb) paintThumb(el, item.thumb);
    else thumbIO.observe(el);
    el.style.setProperty('--ind', `calc(${Math.min(node.depth, 4)} * var(--pl-indent))`);

    /* 双击播放 / 单击选择（现状语义） */
    el.addEventListener('dblclick', () => store.set({ currentId: item.id }, ['currentId']));
    el.addEventListener('click', () => {
      if (store.get().currentId !== item.id) store.set({ currentId: item.id }, ['currentId']);
      else import('../playback/engine.js').then((m) => m.controls.togglePlay());
    });

    /* 拖拽排序：仅同父文件夹文件行之间（文件磁盘不可移动） */
    el.addEventListener('dragstart', (e) => {
      dragId = item.id;
      el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    el.addEventListener('dragend', () => {
      dragId = null;
      el.classList.remove('dragging');
      list.querySelectorAll('.drag-over').forEach((x) => x.classList.remove('drag-over'));
    });
    el.addEventListener('dragover', (e) => {
      if (!dragId) return; /* 外部拖入交给全局处理 */
      if (!sameParent(dragId, item.id) || dragId === item.id) {
        /* 异父 / 自身：不 preventDefault，拦住全局以免误判为合法目标 */
        e.stopPropagation();
        el.classList.remove('drag-over');
        return;
      }
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      el.classList.add('drag-over');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
    el.addEventListener('drop', (e) => {
      el.classList.remove('drag-over');
      if (!dragId || dragId === item.id || !sameParent(dragId, item.id)) return;
      e.preventDefault();
      store.reorderPlaylist(dragId, item.id);
    });
    return el;
  }

  function makeFolderRow(node, { open, isAnc }) {
    const relPath = relPathOf(node);
    const el = h('div', {
      class: `pl-folder${open ? ' open' : ''}${isAnc ? ' ancestor' : ''}${isDriveRoot(node) ? ' drive' : ''}`,
      dataset: { key: node.key },
      title: `${relPath} · 单击展开，双击播放`,
      draggable: 'false',
    },
      h('div', { class: 'pf-chev' }, h('svg', { class: 'ic' }, h('use', { href: '#i-chevron' }))),
      h('div', { class: 'pf-icon' }, h('svg', { class: 'ic' }, h('use', { href: '#i-folder' }))),
      h('div', { class: 'pf-name', text: node.name, title: relPath }),
      h('div', { class: 'pf-count', text: String(node.count) }),
      h('div', { class: 'pf-acts' },
        h('button', {
          class: 'pi-btn', title: '播放',
          onClick: (e) => { e.stopPropagation(); playFirst(node); },
        }, h('svg', { class: 'ic' }, h('use', { href: '#i-play' }))),
        h('button', {
          class: 'pi-btn danger', title: '移除',
          onClick: (e) => {
            e.stopPropagation();
            store.removeFromPlaylist(node.itemIds);
            toast(`已移除 ${node.count} 项`);
          },
        }, h('svg', { class: 'ic' }, h('use', { href: '#i-trash' }))),
      ),
    );
    el.style.setProperty('--ind', `calc(${Math.min(node.depth, 4)} * var(--pl-indent))`);

    /* 单击展开/折叠（严格 detail 1 防双击闪烁）；双击播子树首文件 */
    el.addEventListener('click', (e) => {
      if (e.detail === 1) store.toggleFolder(node.key);
    });
    el.addEventListener('dblclick', () => playFirst(node));

    /* 文件夹行不可拖；内部拖拽悬停出禁用光标，drop 为 no-op */
    el.addEventListener('dragover', (e) => {
      if (dragId) e.stopPropagation();
    });
    el.addEventListener('drop', (e) => {
      if (dragId) e.stopPropagation();
    });
    return el;
  }

  /** 播子树首文件：跳转后 currentId 快路径自动展开祖先链并滚动到位 */
  function playFirst(node) {
    if (!node.firstId) return;
    store.set({ currentId: node.firstId }, ['currentId']);
  }

  /** 拖拽同父判定：FileNode.parent 同一节点引用（根层散文件 parent 均为 null） */
  function sameParent(idA, idB) {
    const tree = store.getPlaylistTree();
    const a = tree.fileById.get(idA);
    const b = tree.fileById.get(idB);
    return !!a && !!b && a.parent === b.parent;
  }

  /* ---------- FLIP 落位：重建前记视口附近行位置，重建后从旧位置滑入 ---------- */
  function captureFlip(rows) {
    const lr = list.getBoundingClientRect();
    const from = new Map();
    for (const [token, el] of rows) {
      const r = el.getBoundingClientRect();
      if (r.bottom < lr.top - 120 || r.top > lr.bottom + 120) continue;
      from.set(token, r.top);
    }
    return from;
  }
  function applyFlip(from, rows) {
    const moves = [];
    for (const [token, el] of rows) {
      const prevTop = from.get(token);
      if (prevTop == null) continue;
      const dy = prevTop - el.getBoundingClientRect().top;
      if (Math.abs(dy) >= 1) moves.push([el, dy]);
    }
    if (!moves.length || moves.length > FLIP_MAX) return;
    for (const [el, dy] of moves) {
      el.style.transition = 'none';
      el.style.transform = `translateY(${dy}px)`;
    }
    void list.offsetHeight; /* 强制回流建立起点 */
    for (const [el] of moves) {
      el.style.transition = ''; /* 回到基础 transition（含 transform 档）滑入 */
      el.style.transform = '';
    }
  }

  /* ---------- 重建可见行 ---------- */
  function rebuild({ mode = 'none', openAnimKey = null, scrollToNow = false, flip = false } = {}) {
    if (collapseTimer) { clearTimeout(collapseTimer); collapseTimer = null; }
    const s = store.get();

    /* 离屏面板不重建 DOM：只同步快照，打开时统一级联重建 */
    if (!panel.classList.contains('open')) {
      visibleRows = new Map();
      rowById.clear();
      rowByKey.clear();
      lastExpanded = new Set(s.plExpanded);
      hasSnap = false;
      return;
    }

    const tree = store.getPlaylistTree();
    const prevRows = visibleRows;
    const scrollTop = list.scrollTop;
    const flipFrom = flip ? captureFlip(prevRows) : null;

    $('#pl-count').textContent = `${s.playlist.length} 项`;
    thumbIO.disconnect(); /* 旧行全部弃用，新行按需重新观察 */
    list.replaceChildren();
    rowById.clear();
    rowByKey.clear();

    if (!s.playlist.length) {
      list.append(h('div', { class: 'pl-empty' },
        h('svg', { class: 'ic' }, h('use', { href: '#i-playlist' })),
        h('div', { text: '播放列表为空' }),
        h('div', { text: '拖入文件或点击上方按钮添加', style: { opacity: '0.6' } }),
      ));
      visibleRows = new Map();
      lastExpanded = new Set(s.plExpanded);
      hasSnap = true;
      syncExpandBtn();
      return;
    }

    const ancKeys = ancestorKeysOf(tree, s.currentId);
    const nextRows = new Map();
    const frag = document.createDocumentFragment();
    let cascadeIdx = 0;

    const animIdxFor = (token) => {
      if (mode === 'none') return null;
      if (mode === 'cascade') return cascadeIdx++;
      return prevRows.has(token) ? null : cascadeIdx++; /* diff-cascade：仅新行级联 */
    };
    const push = (token, el) => {
      applyAnim(el, animIdxFor(token));
      nextRows.set(token, el);
      frag.append(el);
    };

    const walk = (nodes) => {
      for (const node of nodes) {
        if (node.type === 'folder') {
          const open = s.plExpanded.has(node.key);
          const token = `f:${node.key}`;
          const el = makeFolderRow(node, { open, isAnc: ancKeys.has(node.key) });
          if (node.key === openAnimKey && open) el.classList.remove('open'); /* rAF 后补 .open 走过渡 */
          rowByKey.set(node.key, el);
          push(token, el);
          if (open) walk(node.children);
        } else {
          const token = `i:${node.item.id}`;
          const el = makeFileRow(node, { isNow: node.item.id === s.currentId });
          rowById.set(node.item.id, el);
          push(token, el);
        }
      }
    };
    walk(tree.roots);

    list.append(frag);
    if (!scrollToNow) list.scrollTop = scrollTop;
    visibleRows = nextRows;
    lastExpanded = new Set(s.plExpanded);
    hasSnap = true;
    syncExpandBtn();

    if (openAnimKey) {
      /* 新 DOM 从未以闭合态绘制过：强制回流建立 rotate(0) 基线，补 .open 才有 0.18s 过渡 */
      const el = rowByKey.get(openAnimKey);
      if (el) { void el.offsetHeight; el.classList.add('open'); }
    }
    if (flipFrom) applyFlip(flipFrom, nextRows);
    if (scrollToNow) {
      requestAnimationFrame(() => {
        rowById.get(store.get().currentId)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      });
    }
  }

  rebuild({ mode: 'cascade', scrollToNow: true });
}
