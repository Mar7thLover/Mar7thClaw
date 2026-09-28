// Mar7thClaw 桌面壳：托盘常驻 + 置顶面板。核心（src/index.js）是独立的 Node 进程，
// 面板只是它的一个客户端；关掉面板不会影响 Discord bot 和正在跑的任务。
const { app, BrowserWindow, Tray, Menu, nativeImage, globalShortcut, ipcMain, shell, Notification, screen } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
// 任务栏图标的解析链：程序 ID → 开始菜单同 ID 快捷方式 → 快捷方式指向的可执行文件的图标，结果会被资源管理器缓存。
// 所以只在用带头像图标的启动程序 Mar7thClaw.exe 运行时才声明程序 ID、维护快捷方式；
// 退回 electron.exe 运行时一概不碰，免得把 Electron 的图标写进缓存。
// 早期用过的「Mar7thClaw」「Mar7thClaw.Panel」「Mar7thClaw.Desktop」缓存里都已是 Electron 图标，不要再用。
const APP_ID = 'Mar7thClaw.App';
const LAUNCHER_MODE = process.platform === 'win32' && /Mar7thClaw\.exe$/i.test(process.execPath);
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_VALUE = 'Mar7thClaw';
const { execFileSync } = require('node:child_process');

function autostartCommand() {
  return app.isPackaged ? `"${process.execPath}"` : `"${process.execPath}" "${root}"`;
}

// 自启动直接写注册表 Run 项，值名固定，不随 AppUserModelID 变化。
function autostartEnabled() {
  if (process.platform !== 'win32') return app.getLoginItemSettings().openAtLogin;
  try {
    const out = execFileSync('reg', ['query', RUN_KEY, '/v', RUN_VALUE], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.includes(autostartCommand());
  } catch { return false; }
}

// 自启动项还指向旧的 electron.exe 时，改成当前的启动程序（Mar7thClaw.exe）。
function migrateAutostart() {
  if (process.platform !== 'win32' || !/Mar7thClaw\.exe$/i.test(process.execPath)) return;
  try {
    const out = execFileSync('reg', ['query', RUN_KEY, '/v', RUN_VALUE], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    if (/electron\.exe/i.test(out)) setAutostart(true);
  } catch { /* 没有开启自启动 */ }
}

function setAutostart(enable) {
  if (process.platform !== 'win32') return app.setLoginItemSettings({ openAtLogin: enable });
  if (enable) execFileSync('reg', ['add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', autostartCommand(), '/f'], { windowsHide: true, stdio: 'ignore' });
  else {
    try { execFileSync('reg', ['delete', RUN_KEY, '/v', RUN_VALUE, '/f'], { windowsHide: true, stdio: 'ignore' }); } catch { /* 本来就没有 */ }
  }
}
const dataDir = path.join(root, 'data');
const logDir = path.join(dataDir, 'logs');
const windowFile = path.join(dataDir, 'window.json');
const startHidden = process.argv.includes('--hidden');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return fallback; }
}
const port = Number(process.env.CLAW_PORT || readJson(path.join(dataDir, 'config.json'), {}).port || 18790);
const baseUrl = `http://127.0.0.1:${port}`;

// 供安装脚本调用：electron . --set-autostart on|off，设置登录项后立即退出。
const autostartFlag = process.argv.indexOf('--set-autostart');
if (autostartFlag >= 0) {
  if (LAUNCHER_MODE) app.setAppUserModelId(APP_ID);
  app.whenReady().then(() => {
    setAutostart(process.argv[autostartFlag + 1] !== 'off');
    const now = autostartEnabled();
    process.stdout.write(`autostart=${now}
`);
    app.exit(0);
  });
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
if (LAUNCHER_MODE) app.setAppUserModelId(APP_ID);

let win = null;
let tray = null;
let quitting = false;
let prefs = readJson(windowFile, { pinned: true });

function savePrefs() {
  if (win && !win.isMinimized()) prefs.bounds = win.getBounds();
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(windowFile, JSON.stringify(prefs, null, 2));
}

// 用 BGRA 位图画一个粉蓝渐变的圆形图标，免得依赖图片文件。
function makeIcon(size) {
  const buf = Buffer.alloc(size * size * 4);
  const r = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - r;
      const dy = y + 0.5 - r;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const alpha = Math.max(0, Math.min(1, r - dist));
      const t = (x + y) / (2 * size);
      const red = Math.round(127 + (243 - 127) * t);
      const green = Math.round(182 + (156 - 182) * t);
      const blue = Math.round(245 + (192 - 245) * t);
      // 中间留一颗白色的"冰晶"点，托盘里好认。
      const core = dist < size * 0.16 ? 1 : 0;
      const i = (y * size + x) * 4;
      buf[i] = core ? 255 : blue;
      buf[i + 1] = core ? 255 : green;
      buf[i + 2] = core ? 255 : red;
      buf[i + 3] = Math.round(alpha * 255);
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

// 头像图标：取当前角色卡的 PNG（data/cards 优先于内置 cards），裁成带抗锯齿边缘的圆形。
let avatarImage = null;
function avatarPath(cardId) {
  const id = String(cardId || readJson(path.join(dataDir, 'config.json'), {}).card || 'march7th');
  if (!/^[\w\u4e00-\u9fff.-]{1,80}$/.test(id)) return null;
  for (const dir of [path.join(dataDir, 'cards'), path.join(root, 'cards')]) {
    const file = path.join(dir, `${id}.png`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

function loadAvatar(cardId) {
  const file = avatarPath(cardId);
  const image = file ? nativeImage.createFromPath(file) : null;
  avatarImage = image && !image.isEmpty() ? image : null;
}

function circle(image, size) {
  const bitmap = Buffer.from(image.resize({ width: size, height: size, quality: 'best' }).toBitmap());
  const r = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dist = Math.hypot(x + 0.5 - r, y + 0.5 - r);
      const alpha = Math.max(0, Math.min(1, r - dist));
      if (alpha >= 1) continue;
      // 位图是预乘 alpha 的 BGRA，四个通道一起缩放。
      const i = (y * size + x) * 4;
      for (let c = 0; c < 4; c++) bitmap[i + c] = Math.round(bitmap[i + c] * alpha);
    }
  }
  return nativeImage.createFromBitmap(bitmap, { width: size, height: size });
}

// base 为 1x 尺寸，另附 1.25x/1.5x/2x 版本，让 Windows 在高 DPI 下挑最清晰的一张。
function icon(base) {
  if (!avatarImage) return makeIcon(base * 2);
  const result = nativeImage.createEmpty();
  for (const scale of [1, 1.25, 1.5, 2]) {
    const size = Math.round(base * scale);
    result.addRepresentation({ scaleFactor: scale, width: size, height: size, buffer: circle(avatarImage, size).toPNG() });
  }
  return result;
}

function desktopLog(...parts) {
  try {
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, 'desktop.log'), `${new Date().toISOString()} ${parts.join(' ')}\n`);
  } catch { /* 日志失败不影响界面 */ }
}

function applyTaskbarIcon() {
  if (!win || process.platform !== 'win32') return;
  try {
    // 窗口图标直接用内存里的多分辨率图像，随头像实时更新。
    win.setIcon(icon(32));
    if (!LAUNCHER_MODE) {
      desktopLog('[icon] 以 electron.exe 运行：不声明程序 ID，也不改开始菜单快捷方式（运行 npm run build-launcher 生成 Mar7thClaw.exe）');
      return;
    }
    // 快捷方式和重启图标都直接指向带头像图标的 Mar7thClaw.exe。
    ensureStartMenuShortcut(process.execPath);
    win.setAppDetails({
      appId: APP_ID, appIconPath: process.execPath, appIconIndex: 0, relaunchDisplayName: 'Mar7thClaw',
      relaunchCommand: `"${process.execPath}" ${app.isPackaged ? '' : `"${root}"`}`.trim(),
    });
    desktopLog('[icon] 程序 ID', APP_ID, '启动程序', process.execPath);
  } catch (error) {
    desktopLog('[icon] 设置任务栏图标失败：', error.stack || error.message);
  }
}

// Windows 10/11 的任务栏按 AppUserModelID 分组，并从「开始」菜单里同 ID 的快捷方式读取图标；
// 没有这个快捷方式时会退回 electron.exe 的图标，系统通知也可能不显示。所以在这里维护一个。
const startMenuLink = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Mar7thClaw.lnk');
function ensureStartMenuShortcut(iconPath) {
  if (process.platform !== 'win32' || !process.env.APPDATA) return;
  const wanted = {
    target: process.execPath, args: app.isPackaged ? '' : `"${root}"`, cwd: root,
    icon: iconPath, iconIndex: 0, appUserModelId: APP_ID, description: 'Mar7thClaw · 三月七',
  };
  try {
    const current = fs.existsSync(startMenuLink) ? shell.readShortcutLink(startMenuLink) : null;
    const same = current && current.target === wanted.target && current.args === wanted.args && current.icon === wanted.icon && current.appUserModelId === wanted.appUserModelId;
    if (!same) shell.writeShortcutLink(startMenuLink, current ? 'replace' : 'create', wanted);
  } catch (error) {
    console.error(`[desktop] 写入开始菜单快捷方式失败：${error.message}`);
  }
}

function refreshIcons(cardId) {
  loadAvatar(cardId);
  tray?.setImage(icon(16));
  applyTaskbarIcon();
}

function findNode() {
  if (process.env.CLAW_NODE && fs.existsSync(process.env.CLAW_NODE)) return { cmd: process.env.CLAW_NODE, env: {} };
  const exe = process.platform === 'win32' ? 'node.exe' : 'node';
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const file = path.join(dir.replace(/"/g, ''), exe);
    if (dir && fs.existsSync(file)) return { cmd: file, env: {} };
  }
  // 找不到系统 Node 时，让 Electron 自带的 Node 运行时来跑核心。
  return { cmd: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } };
}

async function coreHealthy() {
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok && (await res.json()).name === 'mar7thclaw';
  } catch { return false; }
}

async function ensureCore() {
  if (await coreHealthy()) return true;
  fs.mkdirSync(logDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const out = fs.openSync(path.join(logDir, `core-${stamp}.log`), 'a');
  const node = findNode();
  const child = spawn(node.cmd, [path.join(root, 'src', 'index.js')], {
    cwd: root, detached: true, windowsHide: true, stdio: ['ignore', out, out], env: { ...process.env, ...node.env },
  });
  child.unref();
  for (let i = 0; i < 60; i++) {
    await new Promise(resolve => setTimeout(resolve, 250));
    if (await coreHealthy()) return true;
  }
  return false;
}

function defaultBounds() {
  const area = screen.getPrimaryDisplay().workArea;
  const width = 460;
  const height = Math.min(820, area.height - 40);
  return { width, height, x: area.x + area.width - width - 16, y: area.y + area.height - height - 16 };
}

function visibleOnSomeDisplay(bounds) {
  return screen.getAllDisplays().some(d => {
    const a = d.workArea;
    return bounds.x < a.x + a.width - 40 && bounds.x + bounds.width > a.x + 40 && bounds.y >= a.y - 10 && bounds.y < a.y + a.height - 40;
  });
}

function createWindow() {
  const bounds = prefs.bounds && visibleOnSomeDisplay(prefs.bounds) ? prefs.bounds : defaultBounds();
  win = new BrowserWindow({
    ...bounds, minWidth: 340, minHeight: 420, frame: false, show: false, alwaysOnTop: prefs.pinned !== false,
    backgroundColor: '#f6f4fa', icon: icon(32), title: 'Mar7thClaw', skipTaskbar: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.setAlwaysOnTop(prefs.pinned !== false, 'floating');
  applyTaskbarIcon();
  win.loadURL(`${baseUrl}/`);
  win.once('ready-to-show', () => { if (!startHidden) win.show(); });
  win.on('close', event => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
  });
  win.on('moved', savePrefs);
  win.on('resized', savePrefs);
  // 外部链接交给系统浏览器，面板本身不跳转到别的网站。
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(baseUrl)) { event.preventDefault(); if (/^https?:\/\//.test(url)) shell.openExternal(url); }
  });
  win.webContents.on('did-fail-load', () => setTimeout(async () => { if (await ensureCore()) win.loadURL(`${baseUrl}/`); }, 2000));
}

function toggleWindow() {
  if (!win) return;
  if (win.isVisible() && win.isFocused()) win.hide();
  else { win.show(); win.focus(); }
}

function setPinned(pinned) {
  prefs.pinned = pinned;
  win?.setAlwaysOnTop(pinned, 'floating');
  savePrefs();
  buildTrayMenu();
  return pinned;
}

function buildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示面板', click: () => { win.show(); win.focus(); } },
    { label: '窗口置顶', type: 'checkbox', checked: prefs.pinned !== false, click: item => setPinned(item.checked) },
    { label: '开机自动启动', type: 'checkbox', checked: autostartEnabled(), click: item => {
      setAutostart(item.checked);
      buildTrayMenu();
    } },
    { type: 'separator' },
    { label: '在浏览器中打开', click: () => shell.openExternal(`${baseUrl}/`) },
    { label: '打开日志目录', click: () => shell.openPath(logDir) },
    { label: '打开工作目录', click: () => shell.openPath(path.join(root, 'workspace')) },
    { type: 'separator' },
    { label: '退出面板（三月七继续在后台值班）', click: () => { quitting = true; app.quit(); } },
    { label: '完全退出（同时停止核心与 Discord）', click: async () => {
      quitting = true;
      try {
        const html = await (await fetch(`${baseUrl}/`)).text();
        const token = /name="claw-token" content="([^"]+)"/.exec(html)?.[1];
        await fetch(`${baseUrl}/api/shutdown`, { method: 'POST', headers: { 'x-claw-token': token } });
      } catch { /* 核心已经不在了 */ }
      app.quit();
    } },
  ]));
}

ipcMain.handle('claw:toggle-pin', () => setPinned(!(prefs.pinned !== false)));
ipcMain.handle('claw:is-pinned', () => prefs.pinned !== false);
ipcMain.handle('claw:hide', () => win?.hide());
ipcMain.handle('claw:avatar', (event, cardId) => refreshIcons(cardId));
ipcMain.handle('claw:open-browser', () => shell.openExternal(`${baseUrl}/`));
ipcMain.handle('claw:attention', (event, notify = true) => {
  if (win && !win.isFocused()) {
    // 任务栏按钮始终闪烁提示；系统通知由面板设置决定。
    win.flashFrame(true);
    if (notify && Notification.isSupported()) {
      const n = new Notification({ title: '三月七需要你确认', body: '有一个操作在等你审批，点这里打开面板。', icon: icon(48) });
      n.on('click', () => { win.show(); win.focus(); });
      n.show();
    }
  }
});
ipcMain.handle('claw:notify', (event, title, body) => {
  if (win && !win.isFocused() && Notification.isSupported()) {
    const n = new Notification({ title: String(title).slice(0, 80), body: String(body).slice(0, 200), icon: icon(48) });
    n.on('click', () => { win.show(); win.focus(); });
    n.show();
  }
});

app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });
app.on('before-quit', () => { quitting = true; savePrefs(); });
app.on('window-all-closed', () => { /* 托盘常驻，不随窗口退出 */ });

if (autostartFlag < 0) app.whenReady().then(async () => {
  migrateAutostart();
  loadAvatar();
  tray = new Tray(icon(16));
  tray.setToolTip('Mar7thClaw · 三月七');
  tray.on('click', toggleWindow);
  buildTrayMenu();
  const ok = await ensureCore();
  if (!ok) {
    new Notification({ title: 'Mar7thClaw 核心没有启动', body: `请查看 ${logDir} 里的日志`, icon: icon(48) }).show();
  }
  createWindow();
  globalShortcut.register('Control+Alt+M', toggleWindow);
});
app.on('will-quit', () => globalShortcut.unregisterAll());
