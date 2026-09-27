// Менеджер заказов: резолвит запрос зрителя, прогоняет через настраиваемые фильтры
// и вставляет трек следующим (или отправляет на премодерацию, если включена).
import type { Player } from './player.ts';
import type {
  FilterConfig, QueueSnapshot, RejectCode, RequestRecord, ResolvedTrack, SubmitResult,
} from './types.ts';
import { loadConfig, normalizeConfig, saveConfig } from './config.ts';
import { log } from './log.ts';

const logger = log('requests');
const ACTIVE: ReadonlyArray<RequestRecord['status']> = ['queued', 'pending'];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function fmtDur(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m + ':' + String(s).padStart(2, '0');
}

export class RequestManager {
  private player: Player;
  private historyLimit: number;
  history: RequestRecord[] = []; // все заказы (новые сверху)
  config: FilterConfig;
  // провайдер статуса эфира (задаёт TwitchController; с кэшем). null=нет провайдера.
  private _liveProvider: (() => Promise<boolean | null>) | null = null;
  setLiveProvider(fn: (() => Promise<boolean | null>) | null): void { this._liveProvider = fn; }
  // Онлайн ли стрим (через провайдер). true/false/null (неизвестно).
  async checkLive(): Promise<boolean | null> {
    if (!this._liveProvider) return null;
    try { return await this._liveProvider(); } catch { return null; }
  }
  // id заказов, уже виденных впереди курсора (карточка догрузилась) — для сверки статусов.
  private _seenAhead = new Set<string>();
  // цепочка для сериализации заказов (чтобы одновременные не ломали порядок FIFO).
  private _chain: Promise<unknown> = Promise.resolve();

  constructor(player: Player, { historyLimit = 200 }: { historyLimit?: number } = {}) {
    this.player = player;
    this.historyLimit = historyLimit;
    this.config = loadConfig();
  }

  // --- настройки (правятся на лету, сохраняются в config.json) ---
  getConfig(): FilterConfig { return this.config; }
  setConfig(partial: Partial<FilterConfig>): FilterConfig {
    this.config = normalizeConfig({ ...this.config, ...partial });
    saveConfig(this.config);
    return this.config;
  }

  private _active(): RequestRecord[] {
    return this.history.filter((r) => ACTIVE.includes(r.status));
  }

  // Дубликат — активный (ожидающий) заказ того же трека из НАШЕГО лога. Живую очередь
  // плеера не трогаем: там сотни треков самой Волны, а не заказы.
  private _isDuplicate(trackId: string): RequestRecord | undefined {
    return this._active().find((r) => r.id === trackId);
  }

  // Проверка заказа по настраиваемым правилам. Возвращает код причины (для шаблонов ответов).
  // Модератор и выше (level>=4) освобождены от лимитов/кулдауна (как «broadcaster» на Twitch).
  private _check(
    track: ResolvedTrack, user: string, level: number,
  ): { allowed: boolean; reason?: string; code?: RejectCode; vars?: Record<string, string | number> } {
    const c = this.config;
    const u = user.toLowerCase();
    const exempt = level >= 4;

    if (!c.enabled) return { allowed: false, code: 'disabled', reason: 'приём заказов сейчас выключен' };
    if (c.blockedUsers.includes(u)) return { allowed: false, code: 'blockedUser', reason: 'вы не можете заказывать треки' };
    if (c.blockedTrackIds.includes(String(track.id))) return { allowed: false, code: 'blockedTrack', reason: 'этот трек в чёрном списке' };
    if (track.artist && c.blockedArtists.some((b) => b.toLowerCase() === track.artist!.toLowerCase())) {
      return { allowed: false, code: 'blockedArtist', reason: 'этот исполнитель в чёрном списке' };
    }
    if (track.artistIds && track.artistIds.some((id) => c.blockedArtists.includes(String(id)))) {
      return { allowed: false, code: 'blockedArtist', reason: 'этот исполнитель в чёрном списке' };
    }
    if (track.available === false) return { allowed: false, code: 'unavailable', reason: 'трек недоступен' };
    if (!c.allowExplicit && track.explicit) return { allowed: false, code: 'explicit', reason: 'explicit-треки запрещены' };
    if (c.maxDurationSec != null && track.durationSec != null && track.durationSec > c.maxDurationSec) {
      return { allowed: false, code: 'tooLong', reason: 'трек длиннее лимита (' + fmtDur(c.maxDurationSec) + ')', vars: { maxlength: fmtDur(c.maxDurationSec) } };
    }
    if (!exempt && c.maxPerUser != null) {
      const n = this._active().filter((r) => r.user.toLowerCase() === u).length;
      if (n >= c.maxPerUser) return { allowed: false, code: 'maxUser', reason: 'у вас уже ' + n + ' заказ(ов) в очереди (лимит ' + c.maxPerUser + ')', vars: { maxreq: c.maxPerUser } };
    }
    if (!exempt && c.maxQueue != null && this._active().length >= c.maxQueue) {
      return { allowed: false, code: 'maxQueue', reason: 'очередь заказов заполнена (лимит ' + c.maxQueue + ')', vars: { maxreq: c.maxQueue } };
    }
    if (!exempt && c.userCooldownSec != null && c.userCooldownSec > 0) {
      const last = this.history.find(
        (r) => r.user.toLowerCase() === u && r.status !== 'rejected' && r.status !== 'cancelled',
      );
      if (last) {
        const elapsed = (Date.now() - Date.parse(last.at)) / 1000;
        if (elapsed < c.userCooldownSec) {
          const cd = Math.ceil(c.userCooldownSec - elapsed);
          return { allowed: false, code: 'cooldown', reason: 'подождите ' + cd + ' с перед следующим заказом', vars: { cd } };
        }
      }
    }
    return { allowed: true };
  }

  private _label(r: RequestRecord): string {
    return r.title ? r.title + (r.artist ? ' — ' + r.artist : '') : String(r.id);
  }

  private _record(resolved: ResolvedTrack, user: string, status: RequestRecord['status'], position?: number): RequestRecord {
    const record: RequestRecord = {
      id: resolved.id,
      title: resolved.title,
      artist: resolved.artist,
      source: resolved.source,
      durationSec: resolved.durationSec ?? null,
      user,
      at: new Date().toISOString(),
      position,
      status,
    };
    this.history.unshift(record);
    if (this.history.length > this.historyLimit) this.history.length = this.historyLimit;
    return record;
  }

  // Выполнить действие атомарно относительно других заказов (общая очередь-цепочка).
  private _serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this._chain.then(fn, fn);
    this._chain = run.then(() => undefined, () => undefined);
    return run;
  }

  // FIFO-вставка: найти в живой очереди последний из НАШИХ ещё-не-сыгранных заказов
  // впереди курсора и встать сразу после него (а если заказов нет — сразу после
  // текущего трека). Затем дождаться догрузки, чтобы следующий заказ учёл этот.
  private async _injectFifo(trackId: string): Promise<number> {
    const q = await this.player.getQueue(80);
    const idx = q.index ?? 0;
    const activeIds = new Set(this.history.filter((r) => r.status === 'queued').map((r) => r.id));
    const aheadReqPos = q.items
      .filter((it) => it.pos > idx && it.id && activeIds.has(it.id))
      .map((it) => it.pos);
    const insertPos = aheadReqPos.length ? Math.max(...aheadReqPos) + 1 : idx + 1;

    await this.player.injectAt(trackId, insertPos);

    // settle: ждём, пока карточка догрузится и трек станет видимым впереди курсора,
    // иначе следующий заказ не увидит его и встанет не туда.
    for (let i = 0; i < 10; i++) {
      await sleep(300);
      const q2 = await this.player.getQueue(80);
      const i2 = q2.index ?? 0;
      if (q2.items.some((it) => it.id === trackId && it.pos > i2)) break;
    }
    return insertPos;
  }

  async submit(query: string, user = 'anon', level = 0): Promise<SubmitResult> {
    const q = String(query || '').trim();
    const result = q ? await this._submit(q, user, level) : { ok: false, code: 'empty' as RejectCode, error: 'пустой запрос' };
    // Единый лог ИТОГА заказа — в т.ч. неудачного (раньше «не найдено», дубликат и ошибки
    // молчали, из-за чего в логах не было следа таких заказов).
    if (result.ok && result.request) {
      const r = result.request;
      const label = r.title ? r.title + (r.artist ? ' — ' + r.artist : '') : String(r.id);
      logger.info((result.pending ? 'заказ на премодерацию' : 'заказ принят') + ' (' + user + '): ' + label);
    } else {
      logger.info('заказ отклонён (' + user + '): «' + q + '» — ' + (result.error || result.code || 'причина неизвестна'));
    }
    return result;
  }

  private _submit(q: string, user: string, level: number): Promise<SubmitResult> {
    // Всё, включая resolve, — в одной сериализованной секции. _serialize вызывается
    // синхронно при входе (до любого await), поэтому порядок в цепочке = порядок прихода
    // заказов. Резолв внутри — иначе разное время поиска перемешало бы FIFO.
    return this._serialize<SubmitResult>(async () => {
      let resolved: ResolvedTrack | null;
      try { resolved = await this.player.resolve(q); }
      catch (e) { return { ok: false, code: 'error', error: 'ошибка резолва: ' + (e as Error).message }; }
      if (!resolved || !resolved.id) return { ok: false, code: 'notFound', error: 'трек не найден' };
      const track = resolved;

      const dup = this._isDuplicate(track.id);
      if (dup) {
        const label = dup.title ? dup.title + (dup.artist ? ' — ' + dup.artist : '') : 'трек ' + dup.id;
        return { ok: false, duplicate: true, code: 'duplicate', error: 'уже в очереди: ' + label + (dup.user ? ' (' + dup.user + ')' : ''), vars: { title: dup.title ?? '', artist: dup.artist ?? '' } };
      }

      const gate = this._check(track, user, level);
      if (!gate.allowed) return { ok: false, code: gate.code, error: gate.reason ?? 'заказ отклонён', vars: gate.vars };

      // Премодерация: заказ ждёт подтверждения, в очередь пока не идёт.
      if (this.config.premoderation) {
        const record = this._record(track, user, 'pending');
        return { ok: true, pending: true, request: record };
      }

      let insertPos: number;
      try { insertPos = await this._injectFifo(track.id); }
      catch (e) { return { ok: false, error: 'не удалось поставить в очередь: ' + (e as Error).message }; }

      const record = this._record(track, user, 'queued', insertPos);
      return { ok: true, request: record };
    });
  }

  // --- премодерация ---
  pending(): RequestRecord[] { return this.history.filter((r) => r.status === 'pending'); }

  async approve(trackId: string): Promise<{ ok: boolean; error?: string }> {
    const rec = this.history.find((r) => r.id === String(trackId) && r.status === 'pending');
    if (!rec) return { ok: false, error: 'заказ не найден среди ожидающих' };
    return this._serialize(async () => {
      try {
        const pos = await this._injectFifo(rec.id);
        rec.status = 'queued';
        rec.position = pos;
        rec.at = new Date().toISOString();
      } catch (e) { return { ok: false, error: (e as Error).message }; }
      logger.info('заказ одобрен (' + rec.user + '): ' + this._label(rec));
      return { ok: true };
    });
  }

  reject(trackId: string): { ok: boolean } {
    const rec = this.history.find((r) => r.id === String(trackId) && r.status === 'pending');
    if (rec) { rec.status = 'rejected'; logger.info('заказ отклонён модератором (' + rec.user + '): ' + this._label(rec)); }
    return { ok: true };
  }

  // --- отмена уже стоящего в очереди заказа ---
  async cancel(trackId: string): Promise<{ ok: boolean; error?: string }> {
    const id = String(trackId);
    const rec = this.history.find((r) => r.id === id && (r.status === 'queued' || r.status === 'pending'));
    // Ожидающий премодерации в очереди плеера ещё не стоит — просто снимаем.
    if (rec && rec.status === 'pending') { rec.status = 'cancelled'; logger.info('заказ снят (' + rec.user + '): ' + this._label(rec)); return { ok: true }; }
    try {
      await this.player.remove(id);
      await new Promise((r) => setTimeout(r, 800));
      const q = await this.player.getQueue(60);
      const from = q.index ?? 0;
      if (q.items.some((it) => it.id === id && it.pos >= from)) {
        await this.player.remove(id); // добор, если первая карточка ещё не была догружена
      }
    } catch (e) { return { ok: false, error: (e as Error).message }; }
    if (rec) { rec.status = 'cancelled'; logger.info('заказ снят (' + rec.user + '): ' + this._label(rec)); }
    return { ok: true };
  }

  // Сверка статусов заказов с реальной очередью: заказ становится 'played', когда он
  // стал текущим треком или был впереди курсора, а теперь прошёл. Зовётся сервером на
  // каждом опросе состояния (использует уже полученный снимок очереди).
  reconcile(queue: QueueSnapshot | null | undefined): void {
    if (!queue || !Array.isArray(queue.items)) return;
    const idx = queue.index ?? 0;
    const currentId = queue.items.find((it) => it.isCurrent)?.id ?? null;
    const aheadIds = new Set(queue.items.filter((it) => it.pos > idx && it.id).map((it) => it.id as string));
    for (const r of this.history) {
      if (r.status !== 'queued') continue;
      if (aheadIds.has(r.id)) { this._seenAhead.add(r.id); continue; }
      if (r.id === currentId) { r.status = 'played'; this._seenAhead.delete(r.id); continue; }
      if (this._seenAhead.has(r.id)) { r.status = 'played'; this._seenAhead.delete(r.id); }
    }
  }

  list(): RequestRecord[] { return this.history; }

  // --- помощники для команд чата ---

  // Включить/выключить приём заказов; вернуть новое состояние.
  toggleEnabled(on?: boolean): boolean {
    this.config.enabled = on === undefined ? !this.config.enabled : on;
    saveConfig(this.config);
    return this.config.enabled;
  }

  // Добавить трек в чёрный список (для !bansong).
  blockTrack(trackId: string): void {
    const id = String(trackId);
    if (!this.config.blockedTrackIds.includes(id)) {
      this.config.blockedTrackIds.push(id);
      saveConfig(this.config);
    }
  }

  // Снять последний активный заказ зрителя (для !remove). Вернуть снятую запись или null.
  async removeLastByUser(user: string): Promise<RequestRecord | null> {
    const u = user.toLowerCase();
    const rec = this.history.find((r) => r.user.toLowerCase() === u && r.status === 'queued');
    if (!rec) return null;
    await this.cancel(rec.id);
    return rec;
  }

  // Сколько треков осталось до заказа зрителя (для !pos). Берём самый ранний его queued-заказ.
  async userQueuePosition(user: string): Promise<{ waiting: number; track: RequestRecord } | null> {
    const u = user.toLowerCase();
    const mine = this.history.filter((r) => r.user.toLowerCase() === u && r.status === 'queued');
    if (!mine.length) return null;
    const q = await this.player.getQueue(80);
    const idx = q.index ?? 0;
    let best: { waiting: number; track: RequestRecord } | null = null;
    for (const rec of mine) {
      const item = q.items.find((it) => it.id === rec.id && it.pos > idx);
      if (item) {
        const waiting = item.pos - idx;
        if (!best || waiting < best.waiting) best = { waiting, track: rec };
      }
    }
    return best;
  }
}
