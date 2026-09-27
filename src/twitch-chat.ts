// Клиент Twitch-чата поверх WebSocket-over-TLS (wss://irc-ws.chat.twitch.tv:443).
// Без внешних зависимостей: TLS-сокет + ручной WebSocket (RFC6455) + IRC-протокол Twitch.
import tls from 'node:tls';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const WS_HOST = 'irc-ws.chat.twitch.tv';
const WS_PORT = 443;

// Уровни зрителя. Фолловер по бэджам чата не виден — определяется отдельно через Helix API
// (см. TwitchController), поэтому levelFromTags его не выставляет.
export const LEVEL = { viewer: 0, follower: 1, subscriber: 2, vip: 3, moderator: 4, broadcaster: 5 } as const;
export const LEVEL_NAME: Record<number, string> = {
  0: 'зритель', 1: 'фолловер', 2: 'подписчик', 3: 'VIP', 4: 'модератор', 5: 'стример',
};

export interface ChatMessage {
  user: string;   // отображаемое имя
  login: string;  // логин (нижний регистр)
  userId: string; // twitch user-id (для проверки фолловера)
  text: string;
  level: number;  // 0..5 (см. LEVEL)
}

function levelFromTags(tags: Record<string, string>): number {
  const badges = tags['badges'] || '';
  const has = (b: string): boolean => badges.split(',').some((x) => x.startsWith(b + '/'));
  if (has('broadcaster')) return LEVEL.broadcaster;
  if (tags['mod'] === '1' || has('moderator')) return LEVEL.moderator;
  if (has('vip')) return LEVEL.vip;
  if (tags['subscriber'] === '1' || has('subscriber') || has('founder')) return LEVEL.subscriber;
  return LEVEL.viewer;
}

interface ChatOpts {
  token: string;   // access token (можно с префиксом oauth: или без)
  login: string;   // логин бота
  channel: string; // канал (без #)
}

// Разобрать IRC-строку PRIVMSG в сообщение чата (или null). Вынесено для тестируемости.
export function parsePrivmsg(line: string): ChatMessage | null {
  let rest = line;
  const tags: Record<string, string> = {};
  if (rest.startsWith('@')) {
    const sp = rest.indexOf(' ');
    const tagStr = rest.slice(1, sp);
    rest = rest.slice(sp + 1);
    for (const kv of tagStr.split(';')) {
      const eq = kv.indexOf('=');
      if (eq > 0) tags[kv.slice(0, eq)] = kv.slice(eq + 1);
    }
  }
  const mm = rest.match(/^:([^!]+)![^ ]+ PRIVMSG #[^ ]+ :([\s\S]*)$/);
  if (!mm) return null;
  const login = mm[1]!;
  const text = mm[2]!;
  const user = tags['display-name'] || login;
  return { user, login, userId: tags['user-id'] || '', text, level: levelFromTags(tags) };
}

export class TwitchChat extends EventEmitter {
  private sock: tls.TLSSocket | null = null;
  private buf: Buffer = Buffer.alloc(0);
  private handshakeDone = false;
  private ircBuf = '';
  private token: string;
  private login: string;
  private channel: string;
  private closedByUser = false;
  connected = false;

  constructor(opts: ChatOpts) {
    super();
    this.token = opts.token.replace(/^oauth:/i, '');
    this.login = opts.login.toLowerCase();
    this.channel = opts.channel.toLowerCase().replace(/^#/, '');
  }

  connect(): void {
    this.closedByUser = false;
    this.buf = Buffer.alloc(0);
    this.ircBuf = '';
    this.handshakeDone = false;
    const sock = tls.connect({ host: WS_HOST, port: WS_PORT, servername: WS_HOST }, () => {
      const key = crypto.randomBytes(16).toString('base64');
      sock.write(
        'GET / HTTP/1.1\r\n' +
        'Host: ' + WS_HOST + '\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Key: ' + key + '\r\n' +
        'Sec-WebSocket-Version: 13\r\n\r\n',
      );
    });
    this.sock = sock;
    sock.on('data', (d: Buffer) => this._onData(d));
    sock.on('error', (e: Error) => this.emit('error', e));
    sock.on('close', () => {
      this.connected = false;
      this.emit('close');
      if (!this.closedByUser) setTimeout(() => this.connect(), 3000);
    });
  }

  private _onData(d: Buffer): void {
    this.buf = Buffer.concat([this.buf, d]);
    if (!this.handshakeDone) {
      const idx = this.buf.indexOf('\r\n\r\n');
      if (idx < 0) return;
      const head = this.buf.slice(0, idx).toString('latin1');
      if (!/^HTTP\/1\.1 101/.test(head)) {
        this.emit('error', new Error('WebSocket handshake failed: ' + head.split('\r\n')[0]));
        this.close();
        return;
      }
      this.buf = this.buf.slice(idx + 4);
      this.handshakeDone = true;
      this._sendText('CAP REQ :twitch.tv/tags twitch.tv/commands');
      this._sendText('PASS oauth:' + this.token);
      this._sendText('NICK ' + this.login);
      this._sendText('JOIN #' + this.channel);
    }
    this._parseFrames();
  }

  private _parseFrames(): void {
    while (this.buf.length >= 2) {
      const op = this.buf[0]! & 0x0f;
      const masked = (this.buf[1]! & 0x80) !== 0;
      let len = this.buf[1]! & 0x7f;
      let off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      const maskLen = masked ? 4 : 0;
      if (this.buf.length < off + maskLen + len) return;
      let payload = this.buf.slice(off + maskLen, off + maskLen + len);
      if (masked) {
        const mk = this.buf.slice(off, off + 4);
        const un = Buffer.alloc(len);
        for (let i = 0; i < len; i++) un[i] = payload[i]! ^ mk[i % 4]!;
        payload = un;
      }
      this.buf = this.buf.slice(off + maskLen + len);
      if (op === 0x1) this._onText(payload.toString('utf8'));
      else if (op === 0x9) this._sendFrame(0xA, payload); // ping -> pong
      else if (op === 0x8) { try { this.sock?.end(); } catch { /* */ } }
    }
  }

  private _onText(text: string): void {
    this.ircBuf += text;
    let i: number;
    while ((i = this.ircBuf.indexOf('\r\n')) >= 0) {
      const line = this.ircBuf.slice(0, i);
      this.ircBuf = this.ircBuf.slice(i + 2);
      if (line) this._line(line);
    }
  }

  private _line(line: string): void {
    if (line.startsWith('PING')) { this._sendText('PONG' + line.slice(4)); return; }
    if (/ 001 /.test(line)) { this.connected = true; this.emit('connected'); return; }
    if (/ NOTICE \* :Login authentication failed/i.test(line) || /:tmi\.twitch\.tv NOTICE \* :Improperly/i.test(line)) {
      this.emit('authfail');
      return;
    }
    const m = parsePrivmsg(line);
    if (m) this.emit('message', m);
  }

  private _sendText(s: string): void {
    this._sendFrame(0x1, Buffer.from(s + '\r\n', 'utf8'));
  }

  private _sendFrame(opcode: number, payload: Buffer): void {
    if (!this.sock) return;
    const len = payload.length;
    const mask = crypto.randomBytes(4);
    let header: Buffer;
    if (len < 126) header = Buffer.from([0x80 | opcode, 0x80 | len]);
    else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 0x80 | 127; header.writeUInt32BE(0, 2); header.writeUInt32BE(len, 6); }
    const out = Buffer.alloc(len);
    for (let i = 0; i < len; i++) out[i] = payload[i]! ^ mask[i % 4]!;
    this.sock.write(Buffer.concat([header, mask, out]));
  }

  say(text: string): void {
    if (this.connected) {
      const safe = text.replace(/[\r\n]+/g, ' ').slice(0, 480);
      this._sendText('PRIVMSG #' + this.channel + ' :' + safe);
    }
  }

  close(): void {
    this.closedByUser = true;
    try { this.sock?.end(); } catch { /* ignore */ }
    this.connected = false;
  }
}
