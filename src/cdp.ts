// Минимальный persistent-клиент Chrome DevTools Protocol поверх сырого WebSocket.
// Без внешних зависимостей: ручной RFC6455 (клиентские фреймы маскируются, серверные — нет).
import http from 'node:http';
import crypto from 'node:crypto';
import type { Socket } from 'node:net';

interface Pending {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
}

export interface PageTarget {
  id: string;
  type: string;
  url: string;
  title?: string;
  webSocketDebuggerUrl: string;
}

interface EvaluateOptions {
  awaitPromise?: boolean;
  returnByValue?: boolean;
}

// --- HTTP: запрос к JSON-эндпоинтам отладки клиента ---
export function httpJson(port: number, path: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, timeout: 4000 }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e as Error); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

// Вернуть таргет страницы music-application://desktop/ (главное окно плеера).
export async function getPageTarget(port: number): Promise<PageTarget | null> {
  const list: PageTarget[] = await httpJson(port, '/json/list');
  const page = list.find(
    (t) => t.type === 'page' && typeof t.url === 'string' && t.url.startsWith('music-application'),
  );
  return page ?? null;
}

export class CDP {
  private wsUrl: string;
  private sock: Socket | null = null;
  private _id = 0;
  private _pending = new Map<number, Pending>();
  private _events = new Map<string, Set<(params: any) => void>>();
  private _buf: Buffer = Buffer.alloc(0);

  constructor(wsUrl: string) {
    this.wsUrl = wsUrl;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const u = new URL(this.wsUrl);
      const key = crypto.randomBytes(16).toString('base64');
      const req = http.request({
        host: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET',
        headers: {
          Connection: 'Upgrade', Upgrade: 'websocket',
          'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13',
        },
      });
      req.on('upgrade', (_res, socket) => {
        this.sock = socket;
        socket.on('data', (d: Buffer) => this._onData(d));
        socket.on('close', () => {
          for (const [, p] of this._pending) p.reject(new Error('socket closed'));
          this._pending.clear();
        });
        socket.on('error', () => {});
        resolve();
      });
      req.on('error', reject);
      req.end();
    });
  }

  private _frame(str: string): void {
    const p = Buffer.from(str);
    const len = p.length;
    const mask = crypto.randomBytes(4);
    let h: Buffer;
    if (len < 126) h = Buffer.from([0x81, 0x80 | len]);
    else if (len < 65536) { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 0x80 | 126; h.writeUInt16BE(len, 2); }
    else { h = Buffer.alloc(10); h[0] = 0x81; h[1] = 0x80 | 127; h.writeUInt32BE(0, 2); h.writeUInt32BE(len, 6); }
    const m = Buffer.alloc(len);
    for (let i = 0; i < len; i++) m[i] = p[i]! ^ mask[i % 4]!;
    this.sock!.write(Buffer.concat([h, mask, m]));
  }

  private _onData(d: Buffer): void {
    this._buf = Buffer.concat([this._buf, d]);
    while (this._buf.length >= 2) {
      const op = this._buf[0]! & 0x0f;
      let len = this._buf[1]! & 0x7f;
      let off = 2;
      if (len === 126) { if (this._buf.length < 4) return; len = this._buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this._buf.length < 10) return; len = Number(this._buf.readBigUInt64BE(2)); off = 10; }
      if (this._buf.length < off + len) return;
      const payload = this._buf.subarray(off, off + len);
      this._buf = this._buf.subarray(off + len);
      if (op === 0x1) this._onMessage(payload.toString());
      else if (op === 0x9) this._frame(''); // ping -> pong
      else if (op === 0x8) { try { this.sock!.end(); } catch {} }
    }
  }

  private _onMessage(text: string): void {
    let msg: any;
    try { msg = JSON.parse(text); } catch { return; }
    if (msg.id && this._pending.has(msg.id)) {
      const p = this._pending.get(msg.id)!;
      this._pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    } else if (msg.method) {
      const hs = this._events.get(msg.method);
      if (hs) for (const h of hs) { try { h(msg.params); } catch {} }
    }
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this._id;
      this._pending.set(id, { resolve, reject });
      this._frame(JSON.stringify({ id, method, params }));
    });
  }

  on(method: string, handler: (params: any) => void): void {
    if (!this._events.has(method)) this._events.set(method, new Set());
    this._events.get(method)!.add(handler);
  }

  // Выполнить JS в renderer. Возвращает значение (returnByValue) или бросает при исключении.
  async evaluate(expression: string, opts: EvaluateOptions = {}): Promise<any> {
    const { awaitPromise = true, returnByValue = true } = opts;
    const r = await this.send('Runtime.evaluate', {
      expression, awaitPromise, returnByValue, userGesture: true, allowUnsafeEvalBlockedByCSP: true,
    });
    if (r.exceptionDetails) {
      const ex = r.exceptionDetails;
      const desc = (ex.exception && (ex.exception.description ?? ex.exception.value)) ?? ex.text ?? 'evaluate error';
      throw new Error(String(desc));
    }
    return r.result ? r.result.value : undefined;
  }

  // Доверенный клик по координатам (для кнопок, если понадобится).
  async click(x: number, y: number): Promise<void> {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  }

  close(): void { try { this.sock?.end(); } catch {} }
}
