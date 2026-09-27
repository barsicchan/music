// Самодиагностика: проверка, что обёртка работает с текущей версией клиента ЯМ,
// и отслеживание смены версии (после обновления клиента что-то может сломаться).
import fs from 'node:fs';
import path from 'node:path';
import type { Player } from './player.ts';
import type { DiagReport } from './types.ts';
import { log } from './log.ts';
import { DATA_DIR } from './paths.ts';

const STATE_PATH = path.join(DATA_DIR, '.brsc-state.json');
const logger = log('diag');

export function getStoredVersion(): string | null {
  try { return (JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) as { ymVersion?: string }).ymVersion ?? null; }
  catch { return null; }
}
export function setStoredVersion(v: string): void {
  try { fs.writeFileSync(STATE_PATH, JSON.stringify({ ymVersion: v }, null, 2) + '\n', 'utf8'); }
  catch (e) { logger.error('не удалось сохранить версию', e); }
}

export interface FullDiag extends DiagReport {
  storedVersion: string | null; // последняя ПРОВЕРЕННАЯ версия
  versionChanged: boolean;       // текущая версия отличается от проверенной
  ok: boolean;                   // все проверки прошли
}

export async function runDiagnostics(player: Player): Promise<FullDiag> {
  const report = await player.diagnostics();
  const stored = getStoredVersion();
  const ok = report.passed === report.total;
  const versionChanged = !!(report.version && stored && report.version !== stored);
  // всё прошло → фиксируем текущую версию как проверенную рабочую
  if (ok && report.version) setStoredVersion(report.version);
  return { ...report, storedVersion: stored, versionChanged, ok };
}

export interface DeepStep { name: string; ok: boolean; detail: string; }

// Глубокая проверка: реально вставить трек следующим, убедиться, что появился, и убрать.
export async function deepTest(player: Player): Promise<{ ok: boolean; steps: DeepStep[] }> {
  const steps: DeepStep[] = [];
  const add = (name: string, ok: boolean, detail = ''): void => { steps.push({ name, ok, detail }); };

  let trackId: string | null = null;
  try {
    const t = await player.resolve('Rick Astley Never Gonna Give You Up');
    trackId = t?.id ?? null;
    add('Поиск трека', !!trackId, trackId ? ('id ' + trackId) : 'трек не найден');
  } catch (e) { add('Поиск трека', false, (e as Error).message); }
  if (!trackId) return { ok: false, steps };

  const inQueue = async (): Promise<boolean> => {
    const q = await player.getQueue(80);
    const idx = q.index ?? 0;
    return q.items.some((it) => it.id === trackId && it.pos > idx);
  };

  try {
    await player.playNext(trackId);
    await new Promise((r) => setTimeout(r, 2000));
    const appeared = await inQueue();
    add('Вставка следующим (injectNext)', appeared, appeared ? 'трек появился в очереди' : 'трек не появился');
  } catch (e) { add('Вставка следующим (injectNext)', false, (e as Error).message); }

  try {
    await player.remove(trackId);
    await new Promise((r) => setTimeout(r, 1200));
    const gone = !(await inQueue());
    add('Удаление из очереди (removeByEntityIds)', gone, gone ? 'убран' : 'остался — уберите вручную');
  } catch (e) { add('Удаление из очереди (removeByEntityIds)', false, (e as Error).message); }

  return { ok: steps.every((s) => s.ok), steps };
}
