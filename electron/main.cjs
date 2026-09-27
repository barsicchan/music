// Electron-оболочка brsc / music: одно окно с панелью + иконка в трее.
// Сам бэкенд (Player + Twitch + HTTP-сервер) запускается отдельным Node-процессом
// скрыто (без консоли); окно показывает панель с http://127.0.0.1:<PORT>.
// Бэкенд под присмотром супервайзера: при неожиданном падении — авто-перезапуск
// с обратным отсчётом в окне; после нескольких неудач — предложение перезапустить программу.
const { app, BrowserWindow, Tray, Menu, nativeImage, shell, dialog, ipcMain } = require('electron');
const { spawn, execFileSync } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');

app.setName('brsc-music'); // папка userData = %APPDATA%\brsc-music (стабильно, без пробелов/слэшей)

const ROOT = path.join(__dirname, '..');
const BG = '#0d0a10'; // фон приложения (совпадает с панелью)
// dev: всё рядом с проектом. Упакованный .exe: статика/ассеты в resources (только чтение),
// а конфиги/логи/состояние — в userData (папка для записи).
const PACKED = app.isPackaged;
const RES = PACKED ? process.resourcesPath : ROOT;
const DATA_DIR = PACKED ? app.getPath('userData') : ROOT;
const ASSETS = path.join(PACKED ? RES : ROOT, 'assets');
// сохранённые размеры/позиция окна (запоминаем при выходе, восстанавливаем при запуске)
const WSTATE = path.join(DATA_DIR, '.window-state.json');
function loadWinState() { try { return JSON.parse(fs.readFileSync(WSTATE, 'utf8')); } catch (e) { return null; } }
function saveWinState() { try { if (win && !win.isMaximized() && !win.isMinimized()) fs.writeFileSync(WSTATE, JSON.stringify(win.getBounds())); } catch (e) {} }
// порт берём из app.json (правится в панели), env.PORT — приоритетный ручной оверрайд
function readPort() {
  try {
    const raw = require('node:fs').readFileSync(path.join(DATA_DIR, 'app.json'), 'utf8');
    const p = Number(JSON.parse(raw).port);
    if (Number.isInteger(p) && p >= 1 && p <= 65535) return p;
  } catch (e) { /* нет файла — дефолт */ }
  return 8620;
}
const PORT = Number(process.env.PORT || readPort());
const URL = 'http://127.0.0.1:' + PORT;
const ICON = path.join(ASSETS, 'icon-note.png');

// поведение крестика: сворачивать в трей (по умолчанию) или закрывать приложение.
// читаем свежим из app.json при каждом закрытии — настройка правится в панели на лету.
function readCloseToTray() {
  try {
    const raw = require('node:fs').readFileSync(path.join(DATA_DIR, 'app.json'), 'utf8');
    return JSON.parse(raw).closeToTray !== false; // по умолчанию true
  } catch (e) { return true; }
}

// --- параметры супервайзера ---
const MAX_ATTEMPTS = 5;                 // сколько раз пробуем поднять, прежде чем сдаться
const BACKOFF_SEC = [2, 3, 5, 8, 12];   // пауза перед попыткой №1..№5 (сек)
const STABLE_MS = 30000;                // проработал дольше — падение считаем новым инцидентом
const FIRST_TIMEOUT = 90000;            // ждём первый старт (может подниматься клиент ЯМ)
const RETRY_TIMEOUT = 30000;            // ждём поднятие сервера при перезапуске

let win = null;
let tray = null;
let backend = null;
let quitting = false;
let restartAttempt = 0;
let firstStart = true;
let retryTimer = null;

// Освободить порт, если его держит «осиротевший» бэкенд от прошлого запуска.
function freePort() {
  try {
    execFileSync('powershell', ['-NoProfile', '-Command',
      "Get-NetTCPConnection -State Listen -LocalPort " + PORT + " -ErrorAction SilentlyContinue | " +
      "ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }",
    ], { stdio: 'ignore', timeout: 5000 });
  } catch (e) { /* не критично */ }
}

// --- страница-заглушка в окне (общий стиль) ---
function renderPage(innerHtml) {
  const html = `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;height:100%;overflow:hidden}
    body{background:#0d0a10;color:#efecf2;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
      display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;height:100vh;text-align:center;padding:24px}
    .sp{width:34px;height:34px;border-radius:50%;border:3px solid #2b2233;border-top-color:#e83c5d;animation:r .9s linear infinite;margin-bottom:6px}
    @keyframes r{to{transform:rotate(360deg)}}
    .t1{font-size:16px;font-weight:600}
    .t2{font-size:13.5px;color:#9b93a6;line-height:1.5}
    .t2 b{color:#efecf2}
    #c{color:#e83c5d;font-variant-numeric:tabular-nums}
  </style><body>${innerHtml}</body>`;
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

// --- запуск/присмотр за бэкендом ---
function spawnBackend() {
  const env = { ...process.env };
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  env.PORT = String(PORT);

  let cmd, args, opts;
  if (PACKED) {
    // запускаем собранный бэкенд на Node, встроенном в Electron (внешний node не нужен)
    env.ELECTRON_RUN_AS_NODE = '1';
    env.BRSC_DATA_DIR = DATA_DIR;                    // конфиги/логи → userData
    env.BRSC_PUBLIC_DIR = path.join(RES, 'public');  // панель/оверлей/шрифты
    cmd = process.execPath;
    args = [path.join(RES, 'backend', 'backend.cjs')];
    opts = { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] };
  } else {
    // dev: внешний Node с нативным стриппингом TypeScript
    delete env.ELECTRON_RUN_AS_NODE;
    cmd = 'node';
    args = ['src/index.ts'];
    opts = { cwd: ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] };
  }

  const child = spawn(cmd, args, opts);
  backend = child;
  const startedAt = Date.now();

  child.stdout.on('data', (d) => process.stdout.write('[backend] ' + d));
  child.stderr.on('data', (d) => process.stderr.write('[backend] ' + d));

  child.on('error', (e) => {
    if (quitting || child !== backend) return;
    // не удалось даже запустить процесс — перезапуск не поможет
    const hint = PACKED ? '' : ' (в dev-режиме нужен установленный Node.js в PATH)';
    dialog.showErrorBox('brsc / music', 'Не удалось запустить фоновый процесс' + hint + '.\n' + e.message);
    if (win) win.loadURL(renderPage('<div class="t1" style="color:#ff8a8a">Не удалось запустить фоновый процесс</div>' +
      '<div class="t2">' + (PACKED ? 'Попробуйте перезапустить программу.' : 'В dev-режиме нужен Node.js в PATH.') + '</div>'));
  });

  child.on('exit', (code) => {
    if (quitting || child !== backend) return;
    onBackendDown(code, Date.now() - startedAt);
  });

  // дождаться, пока сервер поднимется, и показать панель (или перезапустить, если завис)
  const timeout = firstStart ? FIRST_TIMEOUT : RETRY_TIMEOUT;
  waitForServer(timeout).then((ok) => {
    firstStart = false;
    if (quitting || child !== backend) return;
    if (ok) {
      restartAttempt = 0; // поднялся — сбрасываем счётчик неудач
      if (win) win.webContents.session.clearCache().finally(() => { if (win) win.loadURL(URL); });
    } else if (!child.killed) {
      // процесс жив, но сервер не отвечает — считаем зависанием, гасим (сработает exit → перезапуск)
      try { child.kill(); } catch (e) {}
    }
  });
}

function onBackendDown(code, ranMs) {
  if (ranMs >= STABLE_MS) restartAttempt = 0; // долго работал — это новый инцидент
  restartAttempt++;
  if (restartAttempt > MAX_ATTEMPTS) { showGiveUp(); return; }
  const delaySec = BACKOFF_SEC[Math.min(restartAttempt - 1, BACKOFF_SEC.length - 1)];
  showRestarting(restartAttempt, MAX_ATTEMPTS, delaySec);
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => { if (!quitting) spawnBackend(); }, delaySec * 1000);
}

function showRestarting(attempt, max, delaySec) {
  if (!win) return;
  const inner =
    '<div class="sp"></div>' +
    '<div class="t1">Связь с фоновым процессом потеряна</div>' +
    '<div class="t2">Перезапуск — попытка <b>' + attempt + '</b> из ' + max + '</div>' +
    '<div class="t2">Повтор через <span id="c">' + delaySec + '</span> с…</div>' +
    '<script>(function(){var n=' + delaySec + ';var t=setInterval(function(){n--;var e=document.getElementById("c");' +
    'if(n<=0){clearInterval(t);if(e&&e.parentNode)e.parentNode.textContent="Запускаю бэкенд…";}else if(e)e.textContent=n;},1000);})();<\/script>';
  win.loadURL(renderPage(inner));
}

function showGiveUp() {
  if (win) win.loadURL(renderPage(
    '<div class="t1" style="color:#ff8a8a">Не удалось восстановить фоновый процесс</div>' +
    '<div class="t2">Бэкенд несколько раз подряд завершился и не поднялся.</div>'));
  const choice = dialog.showMessageBoxSync(win || undefined, {
    type: 'error',
    title: 'brsc / music',
    message: 'Фоновый процесс не запускается',
    detail: 'Бэкенд ' + MAX_ATTEMPTS + ' раз подряд завершился и не восстановился.\nПерезапустить программу? Логи — в папке logs.',
    buttons: ['Перезапустить', 'Выход'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (choice === 0) { restartAttempt = 0; firstStart = true; app.relaunch(); quitting = true; app.exit(0); }
  else { quitting = true; app.quit(); }
}

// --- дождаться, пока сервер поднимется ---
function waitForServer(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      const req = http.get({ host: '127.0.0.1', port: PORT, path: '/', timeout: 2000 }, (res) => {
        res.resume();
        resolve(true);
      });
      req.on('error', () => { if (Date.now() > deadline) resolve(false); else setTimeout(tick, 700); });
      req.on('timeout', () => { req.destroy(); if (Date.now() > deadline) resolve(false); else setTimeout(tick, 700); });
    };
    tick();
  });
}

function createWindow() {
  const icon = nativeImage.createFromPath(ICON);
  const st = loadWinState(); // первый запуск (нет файла) → минимальная высота
  win = new BrowserWindow({
    width: (st && st.width) || 1040,
    height: (st && st.height) || 650,
    x: st ? st.x : undefined,
    y: st ? st.y : undefined,
    minWidth: 820,
    minHeight: 650,
    title: 'brsc / music',
    icon,
    backgroundColor: BG,
    autoHideMenuBar: true,
    // кастомная «шапка»: прячем виндовскую рамку/кнопки, свои прозрачные кнопки рисуем в панели
    titleBarStyle: 'hidden',
    webPreferences: { contextIsolation: true, preload: path.join(__dirname, 'preload.cjs') },
  });

  // окно-заглушка на время запуска; панель загрузит spawnBackend, когда сервер поднимется
  win.loadURL(renderPage('<div class="sp"></div><div class="t1">Запускаю brsc / music…</div>'));

  // запоминаем размеры/позицию окна
  win.on('resize', saveWinState);
  win.on('move', saveWinState);

  // внешние ссылки — в системном браузере, и только из белого списка (https + точный хост).
  // Сейчас наружу ведёт одна ссылка — «Открыть страницу входа вручную» (Twitch).
  // Новая внешняя ссылка в панели → добавить её хост сюда, иначе молча не откроется.
  const EXTERNAL_HOSTS = ['id.twitch.tv'];
  const openIfAllowed = (u) => {
    let ok = false;
    try { const p = new URL(u); ok = p.protocol === 'https:' && EXTERNAL_HOSTS.includes(p.hostname); } catch (e) {}
    if (ok) shell.openExternal(u);
    else console.warn('[main] заблокирована внешняя ссылка: ' + String(u).slice(0, 200));
  };
  win.webContents.setWindowOpenHandler(({ url }) => { openIfAllowed(url); return { action: 'deny' }; });
  // само окно никуда не уходит с панели: переход на чужой адрес → во внешний браузер (по тому же списку)
  win.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith(URL + '/') || url === URL) return;
    e.preventDefault();
    openIfAllowed(url);
  });

  // крестик: по настройке — свернуть в трей (по умолчанию) или закрыть приложение
  win.on('close', (e) => {
    saveWinState();
    if (quitting) return;
    if (readCloseToTray()) { e.preventDefault(); win.hide(); }
    else { quitting = true; app.quit(); } // крестик = выход
  });
}

function createTray() {
  const icon = nativeImage.createFromPath(ICON);
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip('brsc / music');
  const menu = Menu.buildFromTemplate([
    { label: 'Показать панель', click: () => { if (win) { win.show(); win.focus(); } } },
    { label: 'Открыть в браузере', click: () => shell.openExternal(URL) },
    { type: 'separator' },
    { label: 'Выход', click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.on('double-click', () => { if (win) { win.show(); win.focus(); } });
}

// один экземпляр
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });

  // кастомные кнопки управления окном (из панели через preload)
  ipcMain.on('win-minimize', () => { if (win) win.minimize(); });
  ipcMain.on('win-maxtoggle', () => { if (win) { if (win.isMaximized()) win.unmaximize(); else win.maximize(); } });
  ipcMain.on('win-close', () => { if (win) win.close(); }); // close → сворачивание в трей (см. обработчик close)

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null); // убрать меню окна (Alt его больше не открывает)
    freePort();
    createWindow();
    spawnBackend();
    createTray();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });

  app.on('window-all-closed', () => { /* держим приложение в трее */ });

  app.on('before-quit', () => { quitting = true; });
  const cleanup = () => {
    clearTimeout(retryTimer);
    if (backend && !backend.killed) { try { backend.kill(); } catch (e) {} }
  };
  app.on('will-quit', cleanup);
  process.on('exit', cleanup);
}
