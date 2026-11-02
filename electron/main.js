/**
 * PotNext — Electron 主进程
 * 职责：窗口管理、系统对话框、文件扫描、设置持久化、截图导出。
 * 渲染进程只通过 preload 暴露的白名单 API 通信（contextIsolation）。
 */
const { app, BrowserWindow, ipcMain, dialog, shell, nativeImage, screen } = require('electron');
const path = require('path');
const fs = require('fs');

/* 允许 file:// 页面加载 ES 模块与本地资源（无打包器架构需要） */
app.commandLine.appendSwitch('allow-file-access-from-files');

const VIDEO_EXTS = new Set([
  '.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v',
  '.mpg', '.mpeg', '.ts', '.m2ts', '.rmvb', '.rm', '.3gp', '.ogv', '.vob',
]);
const SUB_EXTS = new Set(['.srt', '.vtt', '.ass', '.ssa']);
const AUDIO_EXTS = new Set(['.mp3', '.flac', '.wav', '.m4a', '.aac', '.ogg', '.opus', '.wma']);

let win = null;

/* ---------- 设置持久化 ---------- */
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
const playlistsPath = () => path.join(app.getPath('userData'), 'playlists.json');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

/* ---------- 窗口 ---------- */
function createWindow() {
  /* 按工作区自适应定尺寸，避免高 DPI 下溢出屏幕 */
  const wa = screen.getPrimaryDisplay().workArea;
  const width = Math.min(1280, Math.round(wa.width * 0.86));
  const height = Math.min(800, Math.round(wa.height * 0.86));

  win = new BrowserWindow({
    width,
    height,
    minWidth: 720,
    minHeight: 480,
    x: wa.x + Math.round((wa.width - width) / 2),
    y: wa.y + Math.round((wa.height - height) / 2),
    frame: false,                       // 自定义标题栏
    backgroundColor: '#0e0f13',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webgl: true,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
  win.once('ready-to-show', () => {
    win.show();
    const b = win.getBounds();
    const d = screen.getPrimaryDisplay();
    console.log('[potnext] bounds:', JSON.stringify(b), 'scaleFactor:', d.scaleFactor, 'workArea:', JSON.stringify(d.workArea));
    win.webContents.executeJavaScript('({ iw: innerWidth, ih: innerHeight, dpr: devicePixelRatio })')
      .then((r) => console.log('[potnext] viewport:', JSON.stringify(r)));
    /* dev 自动化探针：--eval=<js> 启动后在渲染端执行（截图验证用，打包参数里不会出现） */
    const evalArg = process.argv.find((a) => a.startsWith('--eval='));
    if (evalArg && !app.isPackaged) {
      const code = evalArg.slice('--eval='.length);
      setTimeout(() => {
        win.webContents.executeJavaScript(code)
          .then((r) => console.log('[potnext] eval:', JSON.stringify(r)))
          .catch((e) => console.log('[potnext] eval error:', String(e)));
      }, 800);
    }
  });
  /* 渲染进程 console 转发（排查静默异常） */
  win.webContents.on('console-message', (_e, level, msg) => console.log(`[renderer${level >= 2 ? ' ERR' : ''}]`, msg));
  win.on('maximize', () => win.webContents.send('win:state', { maximized: true }));
  win.on('unmaximize', () => win.webContents.send('win:state', { maximized: false }));
  win.on('enter-full-screen', () => win.webContents.send('win:state', { fullscreen: true }));
  win.on('leave-full-screen', () => win.webContents.send('win:state', { fullscreen: false }));
  win.on('closed', () => { win = null; });
}

/* ---------- IPC：窗口控制 ---------- */
ipcMain.handle('win:minimize', () => win?.minimize());
ipcMain.handle('win:maximize-toggle', () => {
  if (!win) return false;
  win.isMaximized() ? win.unmaximize() : win.maximize();
  return win.isMaximized();
});
ipcMain.handle('win:close', () => win?.close());
ipcMain.handle('win:fullscreen-toggle', () => {
  if (!win) return false;
  win.setFullScreen(!win.isFullScreen());
  return win.isFullScreen();
});
ipcMain.handle('win:is-maximized', () => win?.isMaximized() ?? false);

/* ---------- IPC：文件对话句柄 ---------- */
ipcMain.handle('dialog:openMedia', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: '打开媒体文件',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '媒体文件', extensions: [...VIDEO_EXTS, ...AUDIO_EXTS].map(e => e.slice(1)) },
      { name: '所有文件', extensions: ['*'] },
    ],
  });
  return res.canceled ? [] : res.filePaths;
});

ipcMain.handle('dialog:openFolder', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: '打开文件夹',
    properties: ['openDirectory'],
  });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle('dialog:openSubtitle', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: '加载字幕',
    properties: ['openFile'],
    filters: [{ name: '字幕文件', extensions: [...SUB_EXTS].map(e => e.slice(1)) }],
  });
  return res.canceled ? null : res.filePaths[0];
});

/** 递归扫描目录中的媒体文件 */
ipcMain.handle('fs:scanFolder', async (_e, dir) => {
  const out = [];
  const walk = (d, depth) => {
    if (depth > 10) return; /* 深层课程目录兜底：超 10 层才放弃 */
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) walk(full, depth + 1);
      else if (VIDEO_EXTS.has(path.extname(ent.name).toLowerCase()) || AUDIO_EXTS.has(path.extname(ent.name).toLowerCase())) {
        out.push(full);
      }
    }
  };
  walk(dir, 0);
  out.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN', { numeric: true }));
  return out;
});

/** 同目录下查找同名字幕 */
ipcMain.handle('fs:findSubtitle', async (_e, mediaPath) => {
  try {
    const dir = path.dirname(mediaPath);
    const base = path.basename(mediaPath, path.extname(mediaPath)).toLowerCase();
    const entries = fs.readdirSync(dir);
    const hit = entries.find(f =>
      SUB_EXTS.has(path.extname(f).toLowerCase()) &&
      f.toLowerCase().startsWith(base.slice(0, 12)));
    return hit ? path.join(dir, hit) : null;
  } catch { return null; }
});

ipcMain.handle('fs:exists', (_e, p) => fs.existsSync(p));
ipcMain.handle('fs:readText', (_e, p) => {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
});

/* ---------- IPC：截图 ---------- */
ipcMain.handle('shot:save', async (_e, dataUrl, suggestedName) => {
  const res = await dialog.showSaveDialog(win, {
    title: '保存截图',
    defaultPath: path.join(app.getPath('pictures'), suggestedName || `potnext-${Date.now()}.png`),
    filters: [{ name: 'PNG 图片', extensions: ['png'] }],
  });
  if (res.canceled || !res.filePath) return null;
  const img = nativeImage.createFromDataURL(dataUrl);
  fs.writeFileSync(res.filePath, img.toPNG());
  return res.filePath;
});

/* ---------- IPC：缩略图缓存（userData/thumbs/<key>.jpg） ---------- */
const thumbsDir = () => path.join(app.getPath('userData'), 'thumbs');
ipcMain.handle('thumb:cache', (_e, key, dataUrl) => {
  /* key 来自渲染进程，白名单校验防路径逃逸 */
  if (typeof key !== 'string' || !/^[a-z0-9]{1,16}$/.test(key)) return null;
  const file = path.join(thumbsDir(), `${key}.jpg`);
  if (!dataUrl) return fs.existsSync(file) ? file : null;   /* 查询模式 */
  try {
    fs.mkdirSync(thumbsDir(), { recursive: true });
    fs.writeFileSync(file, nativeImage.createFromDataURL(dataUrl).toJPEG(72));
    return file;
  } catch { return null; }
});

/* ---------- IPC：设置 / 播放列表持久化 ---------- */
ipcMain.handle('settings:load', () => readJson(settingsPath(), {}));
ipcMain.handle('settings:save', (_e, data) => { writeJson(settingsPath(), data); return true; });
ipcMain.handle('playlists:load', () => readJson(playlistsPath(), {}));
ipcMain.handle('playlists:save', (_e, data) => { writeJson(playlistsPath(), data); return true; });

/* ---------- misc ---------- */
ipcMain.handle('shell:showItem', (_e, p) => shell.showItemInFolder(p));
ipcMain.handle('app:version', () => app.getVersion());

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
