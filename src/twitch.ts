// Контроллер Twitch: два аккаунта (основной + бот), выбор «кто отвечает»,
// вход (implicit OAuth flow), чат-подключение и обработка команды !sr → заказ → ответ.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Server } from 'node:http';
import type { Player } from './player.ts';
import type { RequestManager } from './requests.ts';
import type { ReplyWith, TwitchAccount, TwitchConfig, TwitchStatus } from './types.ts';
import { buildAuthorizeUrl, validate, refresh, isFollower, getStreamLive } from './twitch-auth.ts';
import { startCallbackServer, redirectUri } from './twitch-callback.ts';
import { TwitchChat, LEVEL, type ChatMessage } from './twitch-chat.ts';
import { CommandEngine } from './commands.ts';
import { log } from './log.ts';
import { DATA_DIR } from './paths.ts';
import { protect, unprotect } from './secret.ts';

const logger = log('twitch');

const TWITCH_PATH = path.join(DATA_DIR, 'twitch.json');

// Встроенный Client ID приложения «brsc / music» (публичный, не секрет — у implicit flow секрета нет),
// чтобы пользователю не нужно было регистрировать своё приложение. Можно переопределить
// своим в продвинутых настройках.
const DEFAULT_CLIENT_ID = 'hxac06s685tct391ieleyslaeyxzel';

const emptyAccount = (): TwitchAccount => ({ login: '', userId: '', accessToken: '', refreshToken: '', expiresAt: 0 });

const defaultConfig = (): TwitchConfig => ({
  enabled: false,
  clientId: DEFAULT_CLIENT_ID,
  channel: '',
  command: '!sr',
  announce: true,
  replyWith: 'main',
  main: emptyAccount(),
  bot: emptyAccount(),
});

// Токены в twitch.json лежат не открытым текстом, а в поле `secrets` — зашифрованные DPAPI
// (см. secret.ts). Остальные поля (логины, настройки) — как есть.
type SecretBag = { main: { accessToken: string; refreshToken: string }; bot: { accessToken: string; refreshToken: string } };
// кэш последнего шифрования: save() зовётся часто, а токены меняются редко — не гоняем PowerShell зря
let lastSecret: { plain: string; blob: string } | null = null;

function loadTwitch(): TwitchConfig {
  try {
    if (fs.existsSync(TWITCH_PATH)) {
      const raw = JSON.parse(fs.readFileSync(TWITCH_PATH, 'utf8')) as Record<string, unknown>;
      // миграция старого плоского формата (один аккаунт)
      if (raw.accessToken && !raw.main) {
        raw.main = { login: raw.botLogin || '', accessToken: raw.accessToken, refreshToken: raw.refreshToken || '' };
      }
      // хвосты старого формата на верхнем уровне (в т.ч. токен открытым текстом) — не тащим дальше
      delete raw.accessToken; delete raw.refreshToken; delete raw.botLogin;
      const d = defaultConfig();
      const secrets = raw.secrets;
      delete raw.secrets;
      const cfg = {
        ...d,
        ...raw,
        main: { ...emptyAccount(), ...(raw.main as object || {}) },
        bot: { ...emptyAccount(), ...(raw.bot as object || {}) },
      } as TwitchConfig;
      if (typeof secrets === 'string' && secrets) {
        try {
          const plain = unprotect(secrets);
          const bag = JSON.parse(plain) as SecretBag;
          for (const w of ['main', 'bot'] as const) {
            cfg[w].accessToken = bag[w]?.accessToken || '';
            cfg[w].refreshToken = bag[w]?.refreshToken || '';
          }
          lastSecret = { plain, blob: secrets };
        } catch (e) {
          // другой пользователь Windows / файл с другого ПК — токены не прочитать, нужен повторный вход
          logger.warn('не удалось расшифровать токены Twitch — войдите заново (' + (e as Error).message + ')');
          for (const w of ['main', 'bot'] as const) { cfg[w].accessToken = ''; cfg[w].refreshToken = ''; }
        }
      }
      return cfg;
    }
  } catch { /* дефолт */ }
  return defaultConfig();
}

// Сериализовать конфиг для диска: токены — в зашифрованный `secrets`, из аккаунтов — вычищены.
// Если DPAPI недоступен — пишем как раньше (открытым текстом), с предупреждением в лог.
function serializeTwitch(config: TwitchConfig): string {
  const bag: SecretBag = {
    main: { accessToken: config.main.accessToken, refreshToken: config.main.refreshToken },
    bot: { accessToken: config.bot.accessToken, refreshToken: config.bot.refreshToken },
  };
  const plain = JSON.stringify(bag);
  let blob: string;
  try {
    blob = lastSecret && lastSecret.plain === plain ? lastSecret.blob : protect(plain);
    lastSecret = { plain, blob };
  } catch (e) {
    logger.warn('шифрование токенов недоступно, сохраняю открытым текстом: ' + (e as Error).message);
    return JSON.stringify(config, null, 2) + '\n';
  }
  const out = {
    ...config,
    main: { ...config.main, accessToken: '', refreshToken: '' },
    bot: { ...config.bot, accessToken: '', refreshToken: '' },
    secrets: blob,
  };
  return JSON.stringify(out, null, 2) + '\n';
}

export class TwitchController {
  config: TwitchConfig;
  private requests: RequestManager;
  commands: CommandEngine;
  private chat: TwitchChat | null = null;
  private awaiting = false;
  private awaitingWhich: ReplyWith = 'main';
  private authState: string | null = null;
  private authUrl: string | null = null;
  private authTimer: NodeJS.Timeout | null = null;
  private cbServer: Server | null = null;
  private cbPort: number | null = null;
  private error: string | null = null;

  private _liveCache: { value: boolean | null; at: number } | null = null;

  constructor(player: Player, requests: RequestManager) {
    this.requests = requests;
    this.commands = new CommandEngine(player, requests);
    this.config = loadTwitch();
    // миграция: файл с токенами открытым текстом → сразу перезаписать зашифрованным
    if ((this.config.main.accessToken || this.config.bot.accessToken) && !lastSecret) this.save();
    // проверка эфира — по требованию (при заказе), с кэшем; не фоновым опросом
    requests.setLiveProvider(() => this.getLive());
  }

  // Онлайн ли стрим (Helix). Кэш ~30с, чтобы частые заказы не спамили API.
  async getLive(): Promise<boolean | null> {
    const m = this.config.main;
    if (!m.accessToken || !m.userId || !this.config.clientId) return null;
    const now = Date.now();
    if (this._liveCache && now - this._liveCache.at < 30000) return this._liveCache.value;
    const value = await getStreamLive(this.config.clientId, m.accessToken, m.userId);
    this._liveCache = { value, at: now };
    return value;
  }

  private save(): void {
    try { fs.writeFileSync(TWITCH_PATH, serializeTwitch(this.config), 'utf8'); }
    catch (e) { console.error('twitch.json save error:', (e as Error).message); }
  }

  private channelName(): string {
    return (this.config.channel || this.config.main.login || '').toLowerCase().replace(/[^a-z0-9_]/g, '');
  }

  // Аккаунт для ответов/подключения: выбранный, а если он не залогинен — второй (если есть).
  private activeAccount(): { acc: TwitchAccount; which: ReplyWith } {
    const sel = this.config.replyWith;
    const primary = sel === 'bot' ? this.config.bot : this.config.main;
    const other = sel === 'bot' ? this.config.main : this.config.bot;
    if (primary.accessToken) return { acc: primary, which: sel };
    if (other.accessToken) return { acc: other, which: sel === 'bot' ? 'main' : 'bot' };
    return { acc: primary, which: sel };
  }

  getStatus(): TwitchStatus {
    const active = this.activeAccount();
    return {
      configured: !!(this.config.clientId && this.channelName()),
      enabled: this.config.enabled,
      connected: !!this.chat && this.chat.connected,
      channel: this.channelName(),
      clientId: this.config.clientId,
      command: this.config.command,
      announce: this.config.announce,
      replyWith: this.config.replyWith,
      mainLogin: this.config.main.login || null,
      botLogin: this.config.bot.login || null,
      mainExpiresAt: this.config.main.expiresAt || null,
      botExpiresAt: this.config.bot.expiresAt || null,
      activeLogin: (this.chat && this.chat.connected ? active.acc.login : null) || null,
      awaitingAuth: this.awaiting,
      awaitingWhich: this.awaiting ? this.awaitingWhich : undefined,
      authUrl: this.awaiting ? (this.authUrl ?? undefined) : undefined,
      error: this.error,
    };
  }

  // Обновить настройки (без токенов) и переподключиться.
  setConfig(partial: Partial<TwitchConfig>): TwitchStatus {
    const cfg = this.config as unknown as Record<string, unknown>;
    for (const k of ['enabled', 'clientId', 'channel', 'command', 'announce', 'replyWith'] as const) {
      if (partial[k] !== undefined) cfg[k] = partial[k];
    }
    // Client ID Twitch — только [a-z0-9] (уходит в URL и заголовок Client-Id); пустой → встроенный
    this.config.clientId = (this.config.clientId || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '') || DEFAULT_CLIENT_ID;
    // логин Twitch — только [a-z0-9_]; заодно исключает переносы строк в IRC-командах (JOIN #…)
    this.config.channel = (this.config.channel || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
    this.config.command = (this.config.command || '!sr').trim();
    if (this.config.replyWith !== 'bot') this.config.replyWith = 'main';
    // держим триггер команды заказа в синхроне с движком команд
    this.commands.setCommand('sr', { trigger: this.config.command });
    this.save();
    this.error = null;
    void this.connect(); // connect() сам решит: подключиться (есть вход) или отключиться
    return this.getStatus();
  }

  // Начать вход конкретным аккаунтом: поднять колбэк-сервер (первый свободный порт) и
  // собрать ссылку авторизации с соответствующим redirect_uri. Браузер откроет server.ts.
  async startLogin(which: ReplyWith): Promise<{ authUrl: string }> {
    if (!this.config.clientId) throw new Error('Не задан Client ID приложения Twitch');
    this._clearAuthTimer();
    if (!this.cbServer) {
      try {
        const h = await startCallbackServer((state, token) => this.completeAuth(state, token).then(() => {}));
        this.cbServer = h.server;
        this.cbPort = h.port;
      } catch (e) {
        throw new Error('Не удалось открыть порт для входа — все заняты. (' + (e as Error).message + ')');
      }
    }
    // state = который аккаунт + случайная соль (защита от CSRF, сверяем на колбэке)
    const state = which + '.' + crypto.randomBytes(16).toString('hex');
    this.authState = state;
    this.awaiting = true;
    this.awaitingWhich = which;
    this.error = null;
    const url = buildAuthorizeUrl(this.config.clientId, redirectUri(this.cbPort!), state);
    this.authUrl = url;
    // если вход не подтвердят за 5 минут — сбросим ожидание, чтобы UI не завис
    this.authTimer = setTimeout(() => { this._failAuth('вход не подтверждён вовремя, попробуйте снова'); }, 300000);
    return { authUrl: url };
  }

  // Завершить вход: пришёл токен с колбэка (implicit flow, refresh-токена нет).
  async completeAuth(state: string, accessToken: string): Promise<TwitchStatus> {
    if (!this.awaiting || !this.authState || state !== this.authState) {
      throw new Error('Неверный или устаревший state — войдите заново');
    }
    if (!accessToken) throw new Error('Twitch не вернул токен');
    const which = this.awaitingWhich;
    this.authState = null;
    await this._onTokens(which, accessToken, '');
    this._closeCbServer();
    return this.getStatus();
  }

  private _failAuth(msg: string): void {
    this._clearAuthTimer();
    this._closeCbServer();
    this.awaiting = false;
    this.authState = null;
    this.authUrl = null;
    this.error = msg;
  }

  private _clearAuthTimer(): void {
    if (this.authTimer) { clearTimeout(this.authTimer); this.authTimer = null; }
  }

  private _closeCbServer(): void {
    if (this.cbServer) { try { this.cbServer.close(); } catch { /* ignore */ } this.cbServer = null; }
    this.cbPort = null;
  }

  private async _onTokens(which: ReplyWith, accessToken: string, refreshToken: string): Promise<void> {
    this._clearAuthTimer();
    this.awaiting = false;
    this.authState = null;
    this.authUrl = null;
    const acc = which === 'bot' ? this.config.bot : this.config.main;
    acc.accessToken = accessToken;
    acc.refreshToken = refreshToken;
    try {
      const info = await validate(accessToken);
      acc.login = info.login; acc.userId = info.user_id;
      acc.expiresAt = info.expires_in ? Date.now() + info.expires_in * 1000 : 0;
    } catch { /* узнаем при подключении */ }
    if (which === 'main' && !this.config.channel) this.config.channel = acc.login;
    this.config.enabled = true;
    this.save();
    logger.info('вход выполнен (' + which + '): ' + (acc.login || '?'));
    void this.connect();
  }

  logout(which: ReplyWith): TwitchStatus {
    const acc = which === 'bot' ? this.config.bot : this.config.main;
    acc.login = ''; acc.accessToken = ''; acc.refreshToken = ''; acc.expiresAt = 0;
    this.save();
    void this.connect(); // переподключиться другим аккаунтом или отключиться
    if (!this.config.main.accessToken && !this.config.bot.accessToken) this.disconnect();
    return this.getStatus();
  }

  async connect(): Promise<void> {
    const channel = this.channelName();
    const { acc } = this.activeAccount();
    // подключаемся автоматически, если есть вход и канал (галочки «подключаться» больше нет)
    if (!acc.accessToken || !channel) { this.disconnect(); return; }
    this.disconnect();
    let token = acc.accessToken;
    try {
      const info = await validate(token);
      if (info.login) acc.login = info.login;
      if (info.user_id) acc.userId = info.user_id;
      acc.expiresAt = info.expires_in ? Date.now() + info.expires_in * 1000 : 0;
      this.save();
    } catch {
      if (!(await this._tryRefresh(acc))) { this.error = 'токен недействителен, войдите заново'; return; }
      token = acc.accessToken;
    }
    const chat = new TwitchChat({ token, login: acc.login || channel, channel });
    chat.on('connected', () => { this.error = null; logger.info('чат подключён: #' + channel + ' как ' + (acc.login || '?')); });
    chat.on('authfail', async () => {
      logger.warn('authfail в чате, пробую обновить токен');
      if (await this._tryRefresh(acc)) void this.connect();
      else { this.error = 'ошибка авторизации в чате, войдите заново'; logger.error('обновить токен не удалось, нужен повторный вход'); }
    });
    chat.on('error', (e: Error) => { this.error = e.message; logger.error('ошибка чата', e); });
    chat.on('message', (m: ChatMessage) => { void this._onMessage(m); });
    this.chat = chat;
    logger.info('подключаюсь к чату #' + channel);
    chat.connect();
  }

  private async _tryRefresh(acc: TwitchAccount): Promise<boolean> {
    if (!acc.refreshToken || !this.config.clientId) return false;
    try {
      const t = await refresh(this.config.clientId, acc.refreshToken);
      acc.accessToken = t.access_token;
      acc.refreshToken = t.refresh_token;
      acc.expiresAt = t.expires_in ? Date.now() + t.expires_in * 1000 : 0;
      this.save();
      return true;
    } catch { return false; }
  }

  disconnect(): void {
    if (this.chat) { this.chat.close(); this.chat = null; }
  }

  // Определить фолловера (Helix) для зрителей без бэджей. Кэш на 10 минут.
  private _followCache = new Map<string, { follows: boolean; at: number }>();
  private async _resolveLevel(m: ChatMessage): Promise<number> {
    if (m.level > LEVEL.viewer) return m.level; // уже подписчик/VIP/мод/стример
    const main = this.config.main;
    if (!main.accessToken || !main.userId || !m.userId || !this.config.clientId) return m.level;
    const cached = this._followCache.get(m.userId);
    if (cached && Date.now() - cached.at < 600000) return cached.follows ? LEVEL.follower : LEVEL.viewer;
    const res = await isFollower(this.config.clientId, main.accessToken, main.userId, m.userId);
    if (res === null) return m.level; // ошибка API — не понижаем
    this._followCache.set(m.userId, { follows: res, at: Date.now() });
    return res ? LEVEL.follower : LEVEL.viewer;
  }

  private async _onMessage(m: ChatMessage): Promise<void> {
    const text = m.text.trim();
    if (!text.startsWith('!')) return; // быстрый фильтр: команды начинаются с !
    m.level = await this._resolveLevel(m); // фолловеров определяем через API
    let replies: string[];
    try { replies = await this.commands.handle(m); }
    catch (e) { logger.error('ошибка обработки команды', e); return; }
    if (!replies.length) return;
    if (this.config.announce) for (const line of replies) this.chat?.say(line);
  }

  // Обновить логин/срок действия токена у ВСЕХ вошедших аккаунтов (не только активного) —
  // чтобы в панели срок показывался и у основного, и у бота.
  async refreshExpiries(): Promise<void> {
    let changed = false;
    for (const acc of [this.config.main, this.config.bot]) {
      if (!acc.accessToken) continue;
      try {
        const info = await validate(acc.accessToken);
        if (info.login) acc.login = info.login;
        if (info.user_id) acc.userId = info.user_id;
        acc.expiresAt = info.expires_in ? Date.now() + info.expires_in * 1000 : 0;
        changed = true;
      } catch { /* токен мог протухнуть — оставим прежнее значение, покажется как истёкший */ }
    }
    if (changed) this.save();
  }

  async init(): Promise<void> {
    await this.connect().catch((e) => { this.error = (e as Error).message; });
    void this.refreshExpiries();
  }
}
