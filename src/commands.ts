// Движок команд чата: разбирает сообщение, проверяет права по уровню зрителя,
// выполняет действие и возвращает текст ответа по настраиваемому шаблону.
import fs from 'node:fs';
import path from 'node:path';
import type { Player } from './player.ts';
import type { RequestManager } from './requests.ts';
import type { BotCommand, BotConfig, SubmitResult } from './types.ts';
import { LEVEL, LEVEL_NAME, type ChatMessage } from './twitch-chat.ts';
import { log } from './log.ts';
import { DATA_DIR } from './paths.ts';

const BOT_PATH = path.join(DATA_DIR, 'bot.json');
const logger = log('commands');

// id команды -> настройки по умолчанию
const DEFAULT_COMMANDS: Record<string, BotCommand> = {
  sr: { trigger: '!sr', enabled: true, minLevel: 0 },
  song: { trigger: '!song', enabled: true, minLevel: 0 },
  next: { trigger: '!next', enabled: true, minLevel: 0 },
  queue: { trigger: '!queue', enabled: true, minLevel: 0 },
  pos: { trigger: '!pos', enabled: true, minLevel: 0 },
  remove: { trigger: '!remove', enabled: true, minLevel: 0 },
  voteskip: { trigger: '!voteskip', enabled: true, minLevel: 0 },
  cmds: { trigger: '!cmds', enabled: true, minLevel: 0 },
  vol: { trigger: '!vol', enabled: true, minLevel: 4 },
  skip: { trigger: '!skip', enabled: true, minLevel: 4 },
  play: { trigger: '!play', enabled: true, minLevel: 4 },
  pause: { trigger: '!pause', enabled: true, minLevel: 4 },
  bansong: { trigger: '!bansong', enabled: true, minLevel: 4 },
  togglesr: { trigger: '!togglesr', enabled: true, minLevel: 4 },
};

const DEFAULT_RESPONSES: Record<string, string> = {
  // заказ (!sr)
  srAdded: '@{user} ✅ в очереди: {song}',
  srPending: '@{user} ⏳ отправлено на модерацию: {song}',
  srDuplicate: '@{user} ⚠ этот трек уже в очереди',
  srTooLong: '@{user} трек длиннее лимита ({maxlength})',
  srMaxUser: '@{user} у вас уже максимум заказов в очереди ({maxreq})',
  srMaxQueue: '@{user} очередь заказов заполнена ({maxreq})',
  srBlockedArtist: '@{user} этот исполнитель заблокирован',
  srBlockedTrack: '@{user} этот трек заблокирован',
  srBlockedUser: '@{user} вы не можете заказывать треки',
  srExplicit: '@{user} explicit-треки запрещены',
  srCooldown: '@{user} подождите {cd} с перед следующим заказом',
  srNotFound: '@{user} трек не найден',
  srEmpty: '@{user} укажите трек: {cmd} название',
  srDisabled: '@{user} приём заказов сейчас выключен',
  srOffline: '@{user} стрим оффлайн — заказы недоступны',
  srError: '@{user} ошибка: {error}',
  // прочие команды
  offline: '@{user} стрим оффлайн — команды недоступны',
  noPermission: '@{user} команда доступна только: {level} и выше',
  song: 'Сейчас играет: {song}{reqSuffix}',
  songNone: 'Сейчас ничего не играет',
  next: 'Следующий: {song}',
  nextNone: 'Дальше в очереди пусто',
  queue: 'В очереди: {queue}',
  queueNone: 'Очередь пуста',
  pos: '@{user} до твоего трека ({song}) осталось {count} трек(ов)',
  posNone: '@{user} у тебя нет заказов в очереди',
  removed: '@{user} убрал твой заказ: {song}',
  removeNone: '@{user} у тебя нет активных заказов',
  skipped: '@{user} трек пропущен',
  voteskipVote: '@{user} голос за пропуск засчитан ({votes}/{needed})',
  voteskipDone: 'Голосов набрано — пропускаю трек',
  togglesrOn: 'Приём заказов включён',
  togglesrOff: 'Приём заказов выключен',
  play: 'Воспроизведение возобновлено',
  pause: 'Воспроизведение на паузе',
  vol: 'Громкость: {vol}%',
  volSet: 'Громкость установлена: {vol}%',
  bansong: 'Трек {song} добавлен в чёрный список и пропущен',
  cmds: 'Команды: {commands}',
};

function defaultBot(): BotConfig {
  return {
    commands: JSON.parse(JSON.stringify(DEFAULT_COMMANDS)),
    responses: { ...DEFAULT_RESPONSES },
    votesNeeded: 5,
  };
}

function loadBot(): BotConfig {
  const d = defaultBot();
  try {
    if (fs.existsSync(BOT_PATH)) {
      const raw = JSON.parse(fs.readFileSync(BOT_PATH, 'utf8')) as Partial<BotConfig>;
      // мержим с дефолтами, чтобы новые команды/ответы подхватывались
      const commands = { ...d.commands };
      for (const [id, cmd] of Object.entries(raw.commands || {})) commands[id] = { ...commands[id], ...cmd };
      return {
        commands,
        responses: { ...d.responses, ...(raw.responses || {}) },
        votesNeeded: typeof raw.votesNeeded === 'number' ? raw.votesNeeded : d.votesNeeded,
      };
    }
  } catch (e) { logger.error('bot.json read error', e); }
  return d;
}

const strVars = (v: Record<string, string | number>): Record<string, string> => {
  const o: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) o[k] = String(val);
  return o;
};

function render(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{(\w+)\}/g, (_m, k) => (k in vars ? vars[k]! : ''));
}

const songLabel = (artist: string | null | undefined, title: string | null | undefined, id?: string | null): string =>
  title ? (artist ? artist + ' — ' + title : title) : (id ? 'трек ' + id : '—');

export class CommandEngine {
  config: BotConfig;
  private player: Player;
  private requests: RequestManager;
  private _voteTrackId: string | null = null;
  private _votes = new Set<string>();

  constructor(player: Player, requests: RequestManager) {
    this.player = player;
    this.requests = requests;
    this.config = loadBot();
  }

  getConfig(): BotConfig { return this.config; }
  save(): void {
    try { fs.writeFileSync(BOT_PATH, JSON.stringify(this.config, null, 2) + '\n', 'utf8'); }
    catch (e) { logger.error('bot.json save error', e); }
  }
  setResponses(patch: Record<string, string>): BotConfig {
    for (const [k, v] of Object.entries(patch)) if (typeof v === 'string') this.config.responses[k] = v;
    this.save();
    return this.config;
  }
  setCommand(id: string, patch: Partial<BotCommand>): BotConfig {
    if (this.config.commands[id]) {
      this.config.commands[id] = { ...this.config.commands[id], ...patch };
      this.save();
    }
    return this.config;
  }
  setVotesNeeded(n: number): BotConfig { this.config.votesNeeded = Math.max(1, Math.floor(n)); this.save(); return this.config; }

  private r(id: string, vars: Record<string, string | number> = {}): string {
    const tpl = this.config.responses[id] ?? DEFAULT_RESPONSES[id] ?? '';
    return render(tpl, strVars(vars));
  }

  // Разобрать и выполнить команду. Возвращает строки ответа (может быть пусто).
  async handle(msg: ChatMessage): Promise<string[]> {
    const text = msg.text.trim();
    const firstWord = text.split(/\s+/)[0]!.toLowerCase();
    const entry = Object.entries(this.config.commands).find(
      ([, c]) => c.enabled && c.trigger.toLowerCase() === firstWord,
    );
    if (!entry) return [];
    const [id, cmd] = entry;
    const args = text.slice(text.indexOf(firstWord) + firstWord.length).trim();
    // логируем команду ДО обработки — чтобы в логе она шла перед итогом заказа
    logger.info('команда от ' + msg.user + ' [' + msg.level + ']: ' + text);

    if (msg.level < cmd.minLevel) {
      return [this.r('noPermission', { user: msg.user, cmd: cmd.trigger, level: LEVEL_NAME[cmd.minLevel] || '' })];
    }

    // Когда включена опция «только онлайн» и стрим оффлайн — обычные зрители не могут
    // пользоваться ботом; модератор и стример (level>=4) команды используют всегда.
    if (msg.level < LEVEL.moderator && this.requests.config.onlyWhenLive) {
      if ((await this.requests.checkLive()) === false) {
        return [this.r(id === 'sr' ? 'srOffline' : 'offline', { user: msg.user })];
      }
    }

    try {
      const out = await this._dispatch(id, args, msg);
      return out ? [out] : [];
    } catch (e) {
      logger.error('ошибка команды ' + id, e);
      return [this.r('srError', { user: msg.user, error: (e as Error).message })];
    }
  }

  private async _dispatch(id: string, args: string, msg: ChatMessage): Promise<string | null> {
    const user = msg.user;
    switch (id) {
      case 'sr': return this._sr(args, msg);
      case 'song': return this._song();
      case 'next': return this._next();
      case 'queue': return this._queue();
      case 'pos': return this._pos(user);
      case 'remove': return this._remove(user);
      case 'skip': { await this.player.next(); return this.r('skipped', { user }); }
      case 'voteskip': return this._voteskip(msg);
      case 'play': { await this.player.play(); return this.r('play'); }
      case 'pause': { await this.player.pause(); return this.r('pause'); }
      case 'togglesr': { const on = this.requests.toggleEnabled(); return this.r(on ? 'togglesrOn' : 'togglesrOff'); }
      case 'vol': return this._vol(args);
      case 'bansong': return this._bansong();
      case 'cmds': return this._cmds();
      default: return null;
    }
  }

  private async _sr(args: string, msg: ChatMessage): Promise<string> {
    if (!args) return this.r('srEmpty', { user: msg.user, cmd: this.config.commands.sr!.trigger });
    const res: SubmitResult = await this.requests.submit(args, msg.user, msg.level);
    const vars: Record<string, string | number> = { user: msg.user, ...(res.vars || {}) };
    if (res.ok && res.request) {
      const song = songLabel(res.request.artist, res.request.title, res.request.id);
      vars.song = song; vars.artist = res.request.artist ?? ''; vars.title = res.request.title ?? '';
      vars.pos = res.request.position ?? '';
      return this.r(res.pending ? 'srPending' : 'srAdded', vars);
    }
    const map: Record<string, string> = {
      duplicate: 'srDuplicate', tooLong: 'srTooLong', maxUser: 'srMaxUser', maxQueue: 'srMaxQueue',
      blockedArtist: 'srBlockedArtist', blockedTrack: 'srBlockedTrack', blockedUser: 'srBlockedUser',
      explicit: 'srExplicit', cooldown: 'srCooldown', notFound: 'srNotFound', empty: 'srEmpty',
      disabled: 'srDisabled', offline: 'srOffline', error: 'srError',
    };
    const key = map[res.code || 'error'] || 'srError';
    vars.cmd = this.config.commands.sr!.trigger;
    vars.error = res.error ?? '';
    return this.r(key, vars);
  }

  private async _song(): Promise<string> {
    const s = await this.player.getState();
    if (!s.title) return this.r('songNone');
    let reqSuffix = '';
    if (s.currentId) {
      const rec = this.requests.history.find((x) => x.id === s.currentId && (x.status === 'queued' || x.status === 'played'));
      if (rec) reqSuffix = ' (заказал ' + rec.user + ')';
    }
    return this.r('song', { song: songLabel(s.artist, s.title), reqSuffix });
  }

  private async _next(): Promise<string> {
    const q = await this.player.getQueue(10);
    const idx = q.index ?? 0;
    const nxt = q.items.find((it) => it.pos === idx + 1);
    if (!nxt) return this.r('nextNone');
    return this.r('next', { song: songLabel(nxt.artist, nxt.title, nxt.id) });
  }

  private async _queue(): Promise<string> {
    const q = await this.player.getQueue(12);
    const idx = q.index ?? 0;
    const upcoming = q.items.filter((it) => it.pos > idx).slice(0, 5).map((it) => songLabel(it.artist, it.title, it.id));
    if (!upcoming.length) return this.r('queueNone');
    return this.r('queue', { queue: upcoming.join(', ') });
  }

  private async _pos(user: string): Promise<string> {
    const info = await this.requests.userQueuePosition(user);
    if (!info) return this.r('posNone', { user });
    return this.r('pos', { user, count: info.waiting, song: songLabel(info.track.artist, info.track.title, info.track.id) });
  }

  private async _remove(user: string): Promise<string> {
    const rec = await this.requests.removeLastByUser(user);
    if (!rec) return this.r('removeNone', { user });
    return this.r('removed', { user, song: songLabel(rec.artist, rec.title, rec.id) });
  }

  private async _voteskip(msg: ChatMessage): Promise<string> {
    const s = await this.player.getState();
    const cur = s.currentId || 'unknown';
    if (this._voteTrackId !== cur) { this._voteTrackId = cur; this._votes.clear(); }
    this._votes.add(msg.login);
    const needed = this.config.votesNeeded;
    if (this._votes.size >= needed) {
      await this.player.next();
      this._votes.clear();
      return this.r('voteskipDone');
    }
    return this.r('voteskipVote', { user: msg.user, votes: this._votes.size, needed });
  }

  private async _vol(args: string): Promise<string> {
    if (args && /^\d{1,3}$/.test(args)) {
      const n = Math.max(0, Math.min(100, parseInt(args, 10)));
      await this.player.setVolume(n / 100);
      return this.r('volSet', { vol: n });
    }
    const s = await this.player.getState();
    const vol = typeof s.volume === 'number' ? Math.round(s.volume * 100) : 0;
    return this.r('vol', { vol });
  }

  private async _bansong(): Promise<string | null> {
    const s = await this.player.getState();
    if (!s.currentId) return null;
    const song = songLabel(s.artist, s.title, s.currentId);
    this.requests.blockTrack(s.currentId);
    await this.player.next();
    return this.r('bansong', { song });
  }

  private _cmds(): string {
    const list = Object.values(this.config.commands).filter((c) => c.enabled).map((c) => c.trigger).join(', ');
    return this.r('cmds', { commands: list });
  }
}

export { DEFAULT_RESPONSES };
