// Локальный колбэк входа Twitch на фиксированном наборе портов (не зависит от порта панели),
// чтобы redirect URL был одинаковым у всех пользователей встроенного приложения «brsc / music».
// Берём первый свободный порт (на случай, если занят). Токен приходит в URL-хэше
// (#access_token=…), серверу не виден — поэтому отдаём HTML, а его JS достаёт токен из хэша
// и шлёт нам POST-ом на этот же порт.
import http from 'node:http';
import type { Server } from 'node:http';

// Несколько кандидатов на случай, если порт занят. ВСЕ должны быть зарегистрированы
// как OAuth Redirect URLs в приложении Twitch — берём первый свободный.
export const CALLBACK_PORTS = [4033, 4034, 4035];
export const CALLBACK_PATH = '/twitch/callback';
export const redirectUri = (port: number): string => 'http://localhost:' + port + CALLBACK_PATH;

export interface CallbackHandle { server: Server; port: number; }

const page = `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>brsc / music — вход в Twitch</title>
<style>
  :root{color-scheme:dark}
  html,body{height:100%;margin:0}
  body{display:flex;align-items:center;justify-content:center;background:#0d0a10;
    font-family:'Segoe UI',system-ui,sans-serif;color:#efe9f2}
  .card{background:#17121d;border:1px solid #2b2233;border-radius:16px;padding:34px 40px;
    max-width:420px;text-align:center;box-shadow:0 18px 50px rgba(0,0,0,.45)}
  .card::before{content:"";display:block;height:4px;border-radius:4px;margin:-14px -20px 20px;
    background:linear-gradient(90deg,#e83c5d,#9147ff)}
  h1{font-size:1.5rem;margin:0 0 8px}
  p{color:#b9adc6;line-height:1.6;margin:6px 0 0}
  .ok h1{color:#3ddc84} .err h1{color:#ff6b6b}
</style></head><body>
<div class="card" id="c"><h1 id="t">Завершаю вход…</h1><p id="m">Секунду.</p></div>
<script>
(function(){
  var t=document.getElementById('t'),m=document.getElementById('m'),c=document.getElementById('c');
  function fail(msg){c.className='err';t.textContent='Не удалось войти';m.textContent=msg||'Попробуйте ещё раз в приложении.';}
  function ok(){c.className='ok';t.textContent='Готово!';m.textContent='brsc / music и Twitch подключены. Можно закрыть эту вкладку.';}
  var h=new URLSearchParams((location.hash||'').replace(/^#/,''));
  var q=new URLSearchParams(location.search||'');
  if(q.get('error')){fail(q.get('error_description')||q.get('error'));return;}
  var token=h.get('access_token'),state=h.get('state');
  if(!token){fail('Twitch не вернул токен.');return;}
  history.replaceState(null,'','${CALLBACK_PATH}');
  fetch('/api/twitch/callback',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({state:state,access_token:token})})
    .then(function(r){return r.json();})
    .then(function(j){if(j&&j.ok)ok();else fail(j&&j.error);})
    .catch(function(){fail('Не удалось связаться с приложением. Оно ещё запущено?');});
})();
</script></body></html>`;

// Та же защита, что у панели: только наш Host (redirect идёт на localhost:<порт>),
// чужой Origin не пускаем, POST — только JSON.
function checkRequest(req: http.IncomingMessage, port: number): boolean {
  const allowed = ['localhost:' + port, '127.0.0.1:' + port];
  if (!allowed.includes(String(req.headers.host || '').toLowerCase())) return false;
  const origin = req.headers.origin;
  if (origin !== undefined && !allowed.some((h) => origin.toLowerCase() === 'http://' + h)) return false;
  if (req.method === 'POST' && !String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return false;
  return true;
}

function createServer(port: number, onToken: (state: string, token: string) => Promise<void>): Server {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!checkRequest(req, port)) { res.writeHead(403); res.end(); return; }
    if (req.method === 'GET' && url.pathname === CALLBACK_PATH) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(page);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/twitch/callback') {
      let body = '';
      req.on('data', (c) => { if (body.length < 16384) body += c; });
      req.on('end', async () => {
        try {
          const { state, access_token } = JSON.parse(body || '{}');
          await onToken(String(state || ''), String(access_token || ''));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: (e as Error).message }));
        }
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
}

// Поднять слушатель колбэка на ПЕРВОМ свободном из CALLBACK_PORTS.
// onToken(state, accessToken) должен бросить при неудаче. Возвращает сервер и занятый порт.
export async function startCallbackServer(onToken: (state: string, token: string) => Promise<void>): Promise<CallbackHandle> {
  let lastErr: Error | null = null;
  for (const port of CALLBACK_PORTS) {
    const server = createServer(port, onToken);
    try {
      await new Promise<void>((resolve, reject) => {
        const onErr = (e: Error): void => reject(e);
        server.once('error', onErr);
        server.listen(port, '127.0.0.1', () => { server.removeListener('error', onErr); resolve(); });
      });
      return { server, port };
    } catch (e) {
      lastErr = e as Error;
      try { server.close(); } catch { /* ignore */ }
    }
  }
  throw new Error('порты входа заняты (' + CALLBACK_PORTS.join(', ') + ')' + (lastErr ? ': ' + lastErr.message : ''));
}
