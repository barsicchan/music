// Запуск/подключение к клиенту Яндекс Музыки с включённой удалённой отладкой.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { getPageTarget, type PageTarget } from './cdp.ts';

const DEFAULT_EXE = path.join(
  process.env.LOCALAPPDATA ?? '',
  'Programs', 'YandexMusic', 'Яндекс Музыка.exe',
);

export function findYmExe(): string | null {
  if (process.env.YM_EXE && fs.existsSync(process.env.YM_EXE)) return process.env.YM_EXE;
  if (fs.existsSync(DEFAULT_EXE)) return DEFAULT_EXE;
  // fallback: вытащить путь из реестра (обработчик протокола yandexmusic://)
  try {
    const out = execFileSync('reg', [
      'query', 'HKCU\\Software\\Classes\\yandexmusic\\shell\\open\\command', '/ve',
    ], { encoding: 'utf8' });
    const m = out.match(/"([^"]+\.exe)"/);
    if (m && fs.existsSync(m[1]!)) return m[1]!;
  } catch {}
  return null;
}

export function cdpAlive(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/json/version', timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Закрыть все процессы клиента (если он запущен в обычном режиме — без отладки).
// Нужно, потому что single-instance не даст поднять второй экземпляр с флагом.
function closeYm(exe: string): void {
  try {
    execFileSync('taskkill', ['/F', '/IM', path.basename(exe)], { stdio: 'ignore' });
  } catch { /* не запущен — ок */ }
}

// Запустить клиент, если он ещё не поднят с отладкой. Критично: убрать
// ELECTRON_RUN_AS_NODE, иначе exe стартует как голый Node и окно не появится.
export async function ensureYmRunning(
  { port = 9222, timeoutMs = 40000 }: { port?: number; timeoutMs?: number } = {},
): Promise<{ launched: boolean; exe?: string }> {
  if (await cdpAlive(port)) return { launched: false };

  const exe = findYmExe();
  if (!exe) {
    throw new Error(
      'Не найден exe Яндекс Музыки. Укажите путь через переменную YM_EXE или запустите клиент сами с --remote-debugging-port=' + port,
    );
  }

  // CDP недоступен, значит либо клиент не запущен, либо запущен в обычном режиме.
  // Во втором случае его надо закрыть — иначе новый запуск с флагом просто
  // перекинется на существующий экземпляр без отладки.
  closeYm(exe);
  await sleep(1500);

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;

  const child = spawn(exe, [`--remote-debugging-port=${port}`], {
    cwd: path.dirname(exe),
    env,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(1000);
    if (await cdpAlive(port)) return { launched: true, exe };
  }
  throw new Error('Клиент запущен, но CDP не поднялся за ' + (timeoutMs / 1000) + 'с');
}

// Дождаться, пока появится страница плеера (music-application://desktop/).
export async function waitForPlayerPage(
  { port = 9222, timeoutMs = 40000 }: { port?: number; timeoutMs?: number } = {},
): Promise<PageTarget> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const page = await getPageTarget(port);
      if (page && page.webSocketDebuggerUrl) return page;
    } catch {}
    await sleep(1000);
  }
  throw new Error('Страница плеера не появилась за отведённое время');
}
