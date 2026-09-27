// Высокоуровневая обёртка над CDP: подключается к клиенту ЯМ, внедряет агент
// и предоставляет типизированные методы управления плеером.
import { CDP } from './cdp.ts';
import { AGENT_SOURCE } from './agent.ts';
import { ensureYmRunning, waitForPlayerPage, cdpAlive } from './launcher.ts';
import type { DiagReport, PlayerState, QueueSnapshot, ResolvedTrack } from './types.ts';

interface CallEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

export class Player {
  private port: number;
  private cdp: CDP | null = null;

  constructor({ port = 9222 }: { port?: number } = {}) {
    this.port = port;
  }

  async connect(): Promise<this> {
    await ensureYmRunning({ port: this.port });
    const page = await waitForPlayerPage({ port: this.port });
    this.cdp = new CDP(page.webSocketDebuggerUrl);
    await this.cdp.connect();
    await this.cdp.send('Runtime.enable').catch(() => {});
    await this._installAgent();
    return this;
  }

  private async _installAgent(): Promise<void> {
    // Внедряем агент; повторный вызов безопасен (идемпотентно переустанавливает window.__brsc).
    await this.cdp!.evaluate(AGENT_SOURCE);
  }

  // Вызвать метод агента, вернуть data. При потере агента — переустановить и повторить.
  private async _call<T>(jsCallExpr: string): Promise<T> {
    const wrap = (expr: string): string =>
      `(async () => { try { return JSON.stringify({ ok: true, data: await (${expr}) }); } catch (e) { return JSON.stringify({ ok: false, error: String(e && e.message || e) }); } })()`;

    let raw = await this.cdp!.evaluate(wrap(jsCallExpr));
    let parsed = safeParse<CallEnvelope<T>>(raw);
    if (parsed && parsed.ok === false && /__brsc|not a function|undefined/.test(parsed.error ?? '')) {
      // агент слетел (перезагрузка страницы) — переустановить и повторить один раз
      await this._installAgent();
      raw = await this.cdp!.evaluate(wrap(jsCallExpr));
      parsed = safeParse<CallEnvelope<T>>(raw);
    }
    if (!parsed) throw new Error('bad agent response');
    if (!parsed.ok) throw new Error(parsed.error ?? 'agent error');
    return parsed.data as T;
  }

  // --- состояние ---
  getState(): Promise<PlayerState> { return this._call<PlayerState>('window.__brsc.state()'); }
  getQueue(limit = 20): Promise<QueueSnapshot> { return this._call<QueueSnapshot>(`window.__brsc.queue(${Number(limit)})`); }

  // --- резолв и заказ ---
  resolve(query: string): Promise<ResolvedTrack | null> { return this._call<ResolvedTrack | null>(`window.__brsc.resolve(${JSON.stringify(String(query))})`); }
  search(query: string): Promise<ResolvedTrack | null> { return this._call<ResolvedTrack | null>(`window.__brsc.search(${JSON.stringify(String(query))})`); }
  playNext(trackId: string): Promise<{ ok: boolean; position: number }> { return this._call(`window.__brsc.playNext(${JSON.stringify(String(trackId))})`); }
  injectAt(trackId: string, position: number): Promise<{ ok: boolean; position: number }> { return this._call(`window.__brsc.injectAt(${JSON.stringify(String(trackId))}, ${Number(position)})`); }
  playLast(trackId: string): Promise<{ ok: boolean }> { return this._call(`window.__brsc.playLast(${JSON.stringify(String(trackId))})`); }
  remove(trackId: string): Promise<{ ok: boolean }> { return this._call(`window.__brsc.remove(${JSON.stringify(String(trackId))})`); }

  // --- транспорт ---
  setVolume(v: number): Promise<{ ok: boolean; volume: number }> { return this._call(`window.__brsc.setVolume(${Number(v)})`); }
  play(): Promise<{ ok: boolean }> { return this._call('window.__brsc.play()'); }
  pause(): Promise<{ ok: boolean }> { return this._call('window.__brsc.pause()'); }
  toggle(): Promise<{ ok: boolean }> { return this._call('window.__brsc.toggle()'); }
  next(): Promise<{ ok: boolean }> { return this._call('window.__brsc.next()'); }
  prev(): Promise<{ ok: boolean }> { return this._call('window.__brsc.prev()'); }
  toggleLike(): Promise<{ ok: boolean; liked: boolean }> { return this._call('window.__brsc.toggleLike()'); }

  // --- диагностика ---
  getVersion(): Promise<string | null> { return this._call<string | null>('window.__brsc.version()'); }
  diagnostics(): Promise<DiagReport> { return this._call<DiagReport>('window.__brsc.diagnostics()'); }

  isAlive(): Promise<boolean> { return cdpAlive(this.port); }
  close(): void { this.cdp?.close(); }
}

function safeParse<T>(s: string): T | null {
  try { return JSON.parse(s) as T; } catch { return null; }
}
