/**
 * 播放列表树派生 —— 扁平 items → 层级树（渲染期纯派生视图）。
 * 纯函数无副作用：不读 store、不碰 DOM，可独立单测。
 *
 * 持久化零改动：playlists.json 继续只存 items 扁平数组；
 * 树按 path 的目录派生，展开态由 store 以 key 集合另存 localStorage。
 *
 * 返回 PlaylistTree：
 *   roots     顶层节点数组（先文件夹后文件）
 *   nodeByKey Map<归一化key, FolderNode> —— key 为完整归一化路径（含 LCP 段），跨 LCP 漂移稳定
 *   fileById  Map<item.id, FileNode>
 *   folders   全部 FolderNode（创建序，供「展开全部」取 key）
 *   total     文件总数
 *
 * FolderNode：{ type:'folder', key, name, depth, children, count, firstId, itemIds, parent }
 * FileNode：  { type:'file', item, depth, parent }
 *   key     目录段以反斜杠连接后整体转小写（仅身份，不作展示）
 *   name    末段原样（盘符行由 UI 走盘根短样式）
 *   depth   LCP 裁剪后 0 起
 *   count   子树文件总数；firstId 子树首文件 id；itemIds 子树全部 id（均按扁平数组序）
 */

/** 路径切段：斜杠/反斜杠连续分隔、滤空；末段为文件名，其余为目录段 */
function splitPath(path) {
  return String(path ?? '').split(/[\\/]+/).filter(Boolean);
}

/** 子节点排序：先文件夹（中文自然序，与 fs:scanFolder 同源）后文件（数组序，稳定排序保序） */
function sortChildren(arr) {
  arr.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    return a.type === 'folder'
      ? a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true })
      : 0;
  });
  return arr;
}

export function deriveTree(items) {
  /* 1) 切段：目录段保留原样（显示名用），文件行身份用 item.id */
  const entries = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!item) continue;
    const segs = splitPath(item.path);
    entries.push({ item, dirs: segs.slice(0, -1) });
  }

  /* 2) LCP 裁剪：全部条目目录段的最长公共前缀（大小写不敏感），roots 为其下第一层；
        LCP 为空（跨盘符/散文件）时盘符段自然成为根（盘根行）。 */
  let lcp = 0;
  if (entries.length) {
    const first = entries[0].dirs;
    scan: for (; lcp < first.length; lcp += 1) {
      const seg = first[lcp].toLowerCase();
      for (let i = 1; i < entries.length; i += 1) {
        const dirs = entries[i].dirs;
        if (lcp >= dirs.length || dirs[lcp].toLowerCase() !== seg) break scan;
      }
    }
  }

  /* 3) 建树：沿目录链建 FolderNode，key 为完整归一化路径（含 LCP 段），
        itemIds/firstId/count 按扁平数组序沿链累积（O(N×L)）。 */
  const nodeByKey = new Map();
  const fileById = new Map();
  const folders = [];
  const roots = [];

  for (const { item, dirs } of entries) {
    let key = '';
    let parent = null;
    for (let i = 0; i < dirs.length; i += 1) {
      key = key ? `${key}\\${dirs[i].toLowerCase()}` : dirs[i].toLowerCase();
      if (i < lcp) continue; // LCP 段裁掉，不建节点
      let node = nodeByKey.get(key);
      if (!node) {
        node = {
          type: 'folder', key, name: dirs[i], depth: i - lcp,
          children: [], count: 0, firstId: item.id, itemIds: [], parent,
        };
        nodeByKey.set(key, node);
        folders.push(node);
        (parent ? parent.children : roots).push(node);
      }
      node.itemIds.push(item.id);
      node.count += 1;
      parent = node;
    }
    const fileNode = { type: 'file', item, depth: dirs.length - lcp, parent };
    fileById.set(item.id, fileNode);
    (parent ? parent.children : roots).push(fileNode);
  }

  /* 4) 排序：先文件夹后文件（文件夹中文自然序，文件保持数组序 = 播放序） */
  for (const node of folders) sortChildren(node.children);
  sortChildren(roots);

  return { roots, nodeByKey, fileById, folders, total: entries.length };
}
