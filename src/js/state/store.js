/**
 * 全局状态：单向数据流 —— 组件调用 action → store 更新 → 事件通知组件渲染。
 * 不引入框架依赖；订阅粒度为「键」，避免全量重渲染。
 */
import { deriveTree } from './playlist-tree.js';

const listeners = new Map(); // key -> Set<fn>

const state = {
  /* 播放 */
  currentId: null,        // 播放列表条目 id
  playing: false,
  currentTime: 0,
  duration: 0,
  buffered: 0,
  volume: 1,
  muted: false,
  rate: 1,
  fullscreen: false,
  maximized: false,

  /* 界面 */
  view: 'player',         // player | settings
  homeOpen: true,         // 主页纵向浏览器可见：开屏即铺开；开始播放切画面，返回（Esc/左上角）回主页
  playlistOpen: false,    // 开屏不压侧栏：主页纵向浏览器直接铺开，右缘热区/B 键再唤
  controlsVisible: true,
  seekPreview: null,      // { ratio, time, x }
  toast: null,

  /* 设置 */
  settings: {
    theme: 'dark',          // dark | light
    accent: 'aurora',       // 强调色主题
    autoPlayNext: true,
    rememberPosition: true,
    seekStepSmall: 5,
    seekStepLarge: 30,
    showSubtitles: true,
    hardwareAccel: true,
  },

  /* 播放列表（当前活动列表） */
  playlist: [],           // [{ id, path, title, ext, duration, lastPosition, thumb }]
  plExpanded: new Set(),  // 展开的文件夹 key 集合（归一化完整路径）
};

function emit(key) {
  listeners.get(key)?.forEach((fn) => fn(state));
  listeners.get('*')?.forEach((fn) => fn(state, key));
}

export function get() { return state; }

export function subscribe(key, fn) {
  if (!listeners.has(key)) listeners.set(key, new Set());
  listeners.get(key).add(fn);
  return () => listeners.get(key).delete(fn);
}

export function set(patch, keys) {
  Object.assign(state, patch);
  const changed = keys || Object.keys(patch);
  for (const k of changed) emit(k);
}

export function setSetting(key, value) {
  state.settings[key] = value;
  emit('settings');
  persistSettings();
}

/* ---------- 持久化（debounce；两类独立计时，互不吞写） ---------- */
const persistTimers = { settings: null, playlists: null };
function persistNow(kind) {
  const api = window.potnext;
  if (!api) return;
  if (kind === 'playlists' || kind === 'all') api.savePlaylists({ items: state.playlist });
  if (kind === 'settings' || kind === 'all') api.saveSettings(state.settings);
}
export function persistSettings() {
  clearTimeout(persistTimers.settings);
  persistTimers.settings = setTimeout(() => persistNow('settings'), 300);
}
export function persistPlaylist() {
  clearTimeout(persistTimers.playlists);
  persistTimers.playlists = setTimeout(() => persistNow('playlists'), 400);
}
/** 立即落盘（退出前兜底，debounce 定时器在卸载窗口内不会触发） */
export function flushPersist() {
  clearTimeout(persistTimers.settings);
  clearTimeout(persistTimers.playlists);
  persistNow('all');
}

export async function hydrate() {
  const api = window.potnext;
  if (!api) return;
  const [settings, pl] = await Promise.all([api.loadSettings(), api.loadPlaylists()]);
  if (settings && typeof settings === 'object') Object.assign(state.settings, settings);
  if (Array.isArray(pl?.items)) state.playlist = pl.items;
  invalidateTree();
  initExpandedState();
  emit('settings');
  emit('playlist');
  emit('plExpanded');
}

/* ---------- 播放列表操作 ---------- */
export function addToPlaylist(entries, { play = false } = {}) {
  const known = new Set(state.playlist.map((i) => i.path));
  const fresh = entries.filter((e) => !known.has(e.path));
  if (!fresh.length) {
    if (play && entries[0]) {
      const existing = state.playlist.find((i) => i.path === entries[0].path);
      if (existing) set({ currentId: existing.id }, ['currentId']);
    }
    return;
  }
  const prevKeys = new Set(getPlaylistTree().nodeByKey.keys());
  state.playlist.push(...fresh);
  invalidateTree();
  /* 新增文件夹自动展开（只开新节点，用户已折叠的旧节点不动） */
  const tree = getPlaylistTree();
  let grew = false;
  for (const node of tree.folders) {
    if (!prevKeys.has(node.key)) {
      state.plExpanded.add(node.key);
      grew = true;
    }
  }
  if (grew) schedulePersistExpanded();
  emit('playlist');
  persistPlaylist();
  if (play) set({ currentId: fresh[0].id }, ['currentId']);
}

export function removeFromPlaylist(ids) {
  const drop = new Set(ids);
  const wasCurrent = drop.has(state.currentId);
  state.playlist = state.playlist.filter((i) => !drop.has(i.id));
  invalidateTree();
  if (wasCurrent) set({ currentId: state.playlist[0]?.id ?? null }, ['currentId', 'playlist']);
  else emit('playlist');
  persistPlaylist();
}

export function clearPlaylist() {
  state.playlist = [];
  invalidateTree();
  set({ currentId: null }, ['currentId', 'playlist']);
  persistPlaylist();
}

export function reorderPlaylist(fromId, toId) {
  const from = state.playlist.findIndex((i) => i.id === fromId);
  const to = state.playlist.findIndex((i) => i.id === toId);
  if (from < 0 || to < 0 || from === to) return;
  const [item] = state.playlist.splice(from, 1);
  state.playlist.splice(to, 0, item);
  invalidateTree();
  emit('playlist');
  persistPlaylist();
}

export function updateItem(id, patch) {
  const item = state.playlist.find((i) => i.id === id);
  if (!item) return;
  Object.assign(item, patch);
  /* 元数据只发 playlistMeta，不触发列表重建（树缓存不置脏，节点持引用）；
     但 lastPosition/duration/thumb 必须落盘——「记住播放位置」跨重启生效 */
  emit('playlistMeta');
  persistPlaylist();
}

/* ---------- 播放列表树（渲染期派生，惰性缓存） ---------- */
let treeCache = null;
function invalidateTree() { treeCache = null; }

/** 扁平 playlist 的派生层级树：结构变更置脏重建；updateItem / 展开态 / currentId 不置脏 */
export function getPlaylistTree() {
  if (!treeCache) treeCache = deriveTree(state.playlist);
  return treeCache;
}

/* ---------- 文件夹展开态（localStorage，不进持久化文件） ---------- */
/* v2：旧键 potnext.pl.expanded 的残缺记录（只开 1 个根，文件行全被折叠）直接弃用，
 *  换键让默认预填（depth-0+1）重新生效一次；空数组 = 用户主动全折叠，语义保留。 */
const PL_EXPANDED_KEY = 'potnext.pl.expanded.v2';
let plExpTimer = null;
let plExpInited = false;

/** 写前与当前树 nodeByKey 求交，剪枝孤儿 key（渲染忽略、持久化前剪枝） */
function persistExpandedNow() {
  try {
    const { nodeByKey } = getPlaylistTree();
    for (const k of [...state.plExpanded]) {
      if (!nodeByKey.has(k)) state.plExpanded.delete(k);
    }
    localStorage.setItem(PL_EXPANDED_KEY, JSON.stringify([...state.plExpanded]));
  } catch { /* localStorage 不可用：展开态降级为仅内存 */ }
}

function schedulePersistExpanded() {
  clearTimeout(plExpTimer);
  plExpTimer = setTimeout(persistExpandedNow, 400);
}

/** 初始化展开集：无记录预填全部文件夹（课程树层级深，文件行/预览图开场即见，
 *  折叠一键可达——#pl-expand-all 二态按钮）；
 *  有记录（含空数组 = 全折叠，与无记录区分）读入并与当前树求交，孤儿 key 忽略。 */
function initExpandedState() {
  if (plExpInited) return;
  plExpInited = true;
  const tree = getPlaylistTree();
  let keys = null;
  try {
    const raw = localStorage.getItem(PL_EXPANDED_KEY);
    if (raw != null) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) keys = parsed;
    }
  } catch { /* 记录损坏视作无记录，走默认预填 */ }
  if (keys == null) {
    expandAll(tree);
    return;
  }
  for (const k of keys) {
    if (tree.nodeByKey.has(k)) state.plExpanded.add(k);
  }
}

/** 预填展开全部文件夹 */
function expandAll(tree) {
  for (const node of tree.folders) state.plExpanded.add(node.key);
}

/** 切换单个文件夹展开态（单击即调）；不存在的 key 调用合法无害（渲染忽略、持久化前剪枝） */
export function toggleFolder(key) {
  if (state.plExpanded.has(key)) state.plExpanded.delete(key);
  else state.plExpanded.add(key);
  emit('plExpanded');
  schedulePersistExpanded();
}

/** 并集展开：展开全部 / currentId 祖先链自动展开 / 双击文件夹自动展开的统一入口 */
export function expandFolders(keys) {
  let changed = false;
  for (const k of keys || []) {
    if (!state.plExpanded.has(k)) { state.plExpanded.add(k); changed = true; }
  }
  if (!changed) return;
  emit('plExpanded');
  schedulePersistExpanded();
}

/** 全部折叠：清空并持久化空数组（与无记录区分——无记录才走默认预填） */
export function collapseAll() {
  state.plExpanded.clear();
  emit('plExpanded');
  schedulePersistExpanded();
}

/* ---------- 播放导航 ---------- */
export function currentIndex() {
  return state.playlist.findIndex((i) => i.id === state.currentId);
}

export function stepTrack(dir, { shuffle = false } = {}) {
  const n = state.playlist.length;
  if (!n) return;
  let idx;
  if (shuffle && n > 1) {
    do { idx = Math.floor(Math.random() * n); } while (idx === currentIndex());
  } else {
    idx = (currentIndex() + dir + n) % n;
    if (currentIndex() < 0) idx = 0;
  }
  set({ currentId: state.playlist[idx].id }, ['currentId']);
}
