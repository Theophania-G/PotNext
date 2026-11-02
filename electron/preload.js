/**
 * PotNext — preload：向渲染进程暴露白名单 API
 */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('potnext', {
  /* 窗口 */
  minimize: () => ipcRenderer.invoke('win:minimize'),
  maximizeToggle: () => ipcRenderer.invoke('win:maximize-toggle'),
  close: () => ipcRenderer.invoke('win:close'),
  fullscreenToggle: () => ipcRenderer.invoke('win:fullscreen-toggle'),
  isMaximized: () => ipcRenderer.invoke('win:is-maximized'),
  onWinState: (cb) => ipcRenderer.on('win:state', (_e, s) => cb(s)),

  /* 文件 */
  openMedia: () => ipcRenderer.invoke('dialog:openMedia'),
  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  openSubtitle: () => ipcRenderer.invoke('dialog:openSubtitle'),
  scanFolder: (dir) => ipcRenderer.invoke('fs:scanFolder', dir),
  findSubtitle: (mediaPath) => ipcRenderer.invoke('fs:findSubtitle', mediaPath),
  exists: (p) => ipcRenderer.invoke('fs:exists', p),
  readText: (p) => ipcRenderer.invoke('fs:readText', p),

  /* 截图 */
  saveShot: (dataUrl, name) => ipcRenderer.invoke('shot:save', dataUrl, name),

  /* 缩略图缓存：key+dataUrl 写入，key+null 查询 */
  thumbCache: (key, dataUrl) => ipcRenderer.invoke('thumb:cache', key, dataUrl),

  /* 持久化 */
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (data) => ipcRenderer.invoke('settings:save', data),
  loadPlaylists: () => ipcRenderer.invoke('playlists:load'),
  savePlaylists: (data) => ipcRenderer.invoke('playlists:save', data),

  /* misc */
  showItemInFolder: (p) => ipcRenderer.invoke('shell:showItem', p),
  version: () => ipcRenderer.invoke('app:version'),

  /** 将 File 对象解析为可播放的绝对路径（拖拽场景用） */
  filePathOf: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return file?.path || null; }
  },
});
