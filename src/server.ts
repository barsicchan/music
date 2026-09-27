// Локальный HTTP-сервер: отдаёт панель управления и API для заказов/транспорта.
import http from 'node:http';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Player } from './player.ts';
import type { RequestManager } from './requests.ts';
import type { TwitchController } from './twitch.ts';
import { log, recentLogs } from './log.ts';
import { runDiagnostics, deepTest } from './diagnostics.ts';
import { loadAppConfig, saveAppConfig, normalizeApp } from './appconfig.ts';
import { PUBLIC_DIR } from './paths.ts';
import type { AppConfig } from './types.ts';

const logger = log('server');

const PUBLIC = PUBLIC_DIR;

type TransportAction = 'play' | 'pause' | 'toggle' | 'next' | 'prev';

function send(res: ServerResponse, code: number, body: unknown, type = 'application/json; charset=utf-8'): void {
  // no-store: панель/оверлей всегда свежие (Electron иначе кэширует HTML/CSS между запусками)
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store, no-cache, must-revalidate' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

const MAX_BODY = 1024 * 1024; // 1 МБ — с запасом для любых настроек панели

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let d = '';
    let tooBig = false;
    req.on('data', (c) => {
      if (tooBig) return;
      d += c;
      if (d.length > MAX_BODY) { tooBig = true; d = ''; }
    });
    req.on('end', () => { if (tooBig) return resolve({}); try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } });
  });
}

// Защита локального API от чужих сайтов, открытых в браузере:
//  - Host только наш (от DNS rebinding — домен атакующего, «перепривязанный» на 127.0.0.1);
//  - Origin, если есть, только наш (от CSRF со сторонних страниц);
//  - POST только с Content-Type: application/json — такой запрос браузер не отправит
//    с чужого сайта без preflight, а preflight мы не разрешаем.
// Панель в Electron, оверлей в OBS и браузер на http://127.0.0.1:<порт> проходят.
function checkRequest(req: IncomingMessage, port: number): string | null {
  const allowed = ['127.0.0.1:' + port, 'localhost:' + port];
  const host = String(req.headers.host || '').toLowerCase();
  if (!allowed.includes(host)) return 'bad host';
  const origin = req.headers.origin;
  if (origin !== undefined && !allowed.some((h) => origin.toLowerCase() === 'http://' + h)) return 'bad origin';
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    if (req.method !== 'POST') return 'bad method';
    const type = String(req.headers['content-type'] || '').toLowerCase();
    if (!type.startsWith('application/json')) return 'bad content-type';
  }
  return null;
}

export function startServer(
  { player, requests, twitch, port = 8620 }:
    { player: Player; requests: RequestManager; twitch: TwitchController; port?: number },
): Promise<Server> {
  let appCfg: AppConfig = loadAppConfig();
  const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const denied = checkRequest(req, port);
    if (denied) {
      logger.warn('отклонён запрос ' + req.method + ' ' + url.pathname + ': ' + denied +
        ' (host=' + (req.headers.host || '-') + ', origin=' + (req.headers.origin || '-') + ')');
      return send(res, 403, { ok: false, error: 'forbidden' });
    }
    try {
      // --- статика ---
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        return send(res, 200, fs.readFileSync(path.join(PUBLIC, 'index.html')), 'text/html; charset=utf-8');
      }
      // оверлей «сейчас играет» для OBS (Browser Source): /overlay?size=square|slim|regular|large
      if (req.method === 'GET' && (url.pathname === '/overlay' || url.pathname === '/overlay.html')) {
        return send(res, 200, fs.readFileSync(path.join(PUBLIC, 'overlay.html')), 'text/html; charset=utf-8');
      }
      // локальные шрифты (public/fonts): fonts.css + *.woff2
      if (req.method === 'GET' && url.pathname.startsWith('/fonts/')) {
        const rel = url.pathname.slice('/fonts/'.length);
        if (!/^[\w.\-]+$/.test(rel)) return send(res, 400, { ok: false, error: 'bad path' });
        try {
          const buf = fs.readFileSync(path.join(PUBLIC, 'fonts', rel));
          const type = rel.endsWith('.woff2') ? 'font/woff2'
            : rel.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/octet-stream';
          return send(res, 200, buf, type);
        } catch { return send(res, 404, { ok: false, error: 'not found' }); }
      }

      // --- API ---
      if (url.pathname === '/api/state' && req.method === 'GET') {
        const [state, queue] = await Promise.allSettled([player.getState(), player.getQueue(30)]);
        const queueSnap = queue.status === 'fulfilled' ? queue.value : null;
        requests.reconcile(queueSnap); // обновить статусы заказов по реальной очереди
        if (queueSnap && Array.isArray(queueSnap.items)) {
          const hist = requests.list();
          for (const it of queueSnap.items) {
            if (!it.id) continue;
            const rec = hist.find((r) => r.id === it.id && (r.status === 'queued' || r.status === 'played'));
            if (rec) it.by = rec.user;
          }
        }
        return send(res, 200, {
          ok: true,
          connected: await player.isAlive(),
          state: state.status === 'fulfilled' ? state.value : { error: String(state.reason) },
          queue: queueSnap,
          requests: requests.list().slice(0, 20),
          pending: requests.pending(),
          config: requests.getConfig(),
          twitch: twitch.getStatus(),
          overlay: appCfg.overlay,
        });
      }

      if (url.pathname === '/api/logs' && req.method === 'GET') {
        return send(res, 200, { ok: true, lines: recentLogs(400) });
      }

      if (url.pathname === '/api/diagnostics' && req.method === 'GET') {
        try { return send(res, 200, { ok: true, diag: await runDiagnostics(player) }); }
        catch (e) { return send(res, 500, { ok: false, error: (e as Error).message }); }
      }
      if (url.pathname === '/api/diagnostics/deep' && req.method === 'POST') {
        try { return send(res, 200, { ok: true, deep: await deepTest(player) }); }
        catch (e) { return send(res, 500, { ok: false, error: (e as Error).message }); }
      }

      if (url.pathname === '/api/twitch' && req.method === 'GET') {
        return send(res, 200, { ok: true, twitch: twitch.getStatus() });
      }
      if (url.pathname === '/api/twitch/config' && req.method === 'POST') {
        const body = await readBody(req);
        return send(res, 200, { ok: true, twitch: twitch.setConfig(body) });
      }
      if (url.pathname === '/api/twitch/login' && req.method === 'POST') {
        const { which } = await readBody(req);
        const acc = which === 'bot' ? 'bot' : 'main';
        try {
          const r = await twitch.startLogin(acc);
          // открыть системный браузер по умолчанию. Через rundll32 (без cmd/shell), иначе
          // cmd манглит % и & в percent-кодированном URL и Twitch отвергает redirect_uri.
          try {
            spawn('rundll32', ['url.dll,FileProtocolHandler', r.authUrl], { detached: true, stdio: 'ignore' }).unref();
          } catch { /* не критично — в UI есть ссылка «войти вручную» */ }
          return send(res, 200, { ok: true, ...r });
        } catch (e) { return send(res, 400, { ok: false, error: (e as Error).message }); }
      }
      if (url.pathname === '/api/twitch/logout' && req.method === 'POST') {
        const { which } = await readBody(req);
        return send(res, 200, { ok: true, twitch: twitch.logout(which === 'bot' ? 'bot' : 'main') });
      }

      // --- бот: команды и ответы ---
      if (url.pathname === '/api/bot' && req.method === 'GET') {
        return send(res, 200, { ok: true, bot: twitch.commands.getConfig() });
      }
      if (url.pathname === '/api/bot/command' && req.method === 'POST') {
        const { id, ...patch } = await readBody(req);
        return send(res, 200, { ok: true, bot: twitch.commands.setCommand(String(id), patch) });
      }
      if (url.pathname === '/api/bot/responses' && req.method === 'POST') {
        const { responses } = await readBody(req);
        return send(res, 200, { ok: true, bot: twitch.commands.setResponses(responses || {}) });
      }
      if (url.pathname === '/api/bot/votes' && req.method === 'POST') {
        const { votesNeeded } = await readBody(req);
        return send(res, 200, { ok: true, bot: twitch.commands.setVotesNeeded(Number(votesNeeded)) });
      }

      if (url.pathname === '/api/request' && req.method === 'POST') {
        const { query, user } = await readBody(req);
        // заказ из панели = стример: подставляем ник основного канала, а не "panel"
        const who = (!user || user === 'panel') ? (twitch.getStatus().mainLogin || 'стример') : user;
        const r = await requests.submit(query, who, 5); // с панели — уровень стримера (без лимитов)
        return send(res, r.ok ? 200 : 400, r);
      }

      if (url.pathname === '/api/cancel' && req.method === 'POST') {
        const { id } = await readBody(req);
        return send(res, 200, await requests.cancel(id));
      }

      if (url.pathname === '/api/config' && req.method === 'GET') {
        return send(res, 200, { ok: true, config: requests.getConfig() });
      }

      if (url.pathname === '/api/config' && req.method === 'POST') {
        const body = await readBody(req);
        return send(res, 200, { ok: true, config: requests.setConfig(body) });
      }

      // настройки приложения: порт (нужен рестарт) + режим оверлея (обложка/видеошот)
      if (url.pathname === '/api/appconfig' && req.method === 'GET') {
        return send(res, 200, { ok: true, app: appCfg, activePort: port });
      }
      if (url.pathname === '/api/appconfig' && req.method === 'POST') {
        const body = await readBody(req);
        appCfg = normalizeApp({ ...appCfg, ...body, overlay: { ...appCfg.overlay, ...(body?.overlay ?? {}) } });
        saveAppConfig(appCfg);
        // порт применяется только после перезапуска — сообщаем, совпадает ли с текущим
        return send(res, 200, { ok: true, app: appCfg, activePort: port, portChanged: appCfg.port !== port });
      }

      if (url.pathname === '/api/approve' && req.method === 'POST') {
        const { id } = await readBody(req);
        return send(res, 200, await requests.approve(id));
      }

      if (url.pathname === '/api/reject' && req.method === 'POST') {
        const { id } = await readBody(req);
        return send(res, 200, requests.reject(id));
      }

      if (url.pathname === '/api/like' && req.method === 'POST') {
        try { return send(res, 200, await player.toggleLike()); }
        catch (e) { return send(res, 500, { ok: false, error: (e as Error).message }); }
      }

      if (url.pathname === '/api/control' && req.method === 'POST') {
        const { action } = await readBody(req);
        const allowed: TransportAction[] = ['play', 'pause', 'toggle', 'next', 'prev'];
        if (!allowed.includes(action)) return send(res, 400, { ok: false, error: 'unknown action' });
        try { return send(res, 200, await player[action as TransportAction]()); }
        catch (e) { return send(res, 500, { ok: false, error: (e as Error).message }); }
      }

      send(res, 404, { ok: false, error: 'not found' });
    } catch (e) {
      logger.error('ошибка обработки ' + req.method + ' ' + url.pathname, e);
      send(res, 500, { ok: false, error: (e as Error).message });
    }
  });

  return new Promise((resolve, reject) => {
    server.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'EADDRINUSE') reject(new Error('Порт ' + port + ' занят — возможно, приложение уже запущено.'));
      else reject(e);
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}
