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

interface SavedCheck { version: string | null; at: string; ok: boolean; }
interface SavedDiagnostics { ymVersion?: string; basic?: SavedCheck; deep?: SavedCheck; }
function readSaved(): SavedDiagnostics {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { return {}; }
}
export function getStoredVersion(): string | null { return readSaved().ymVersion ?? null; }
export function setStoredVersion(v: string): void {
  writeSaved({ ...readSaved(), ymVersion: v });
}
function writeSaved(state: SavedDiagnostics): void {
  try { fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n', 'utf8'); }
  catch (e) { logger.error('не удалось сохранить диагностику', e); }
}
function saveCheck(kind: 'basic' | 'deep', version: string | null, ok: boolean): void {
  const state = readSaved();
  state[kind] = { version, at: new Date().toISOString(), ok };
  if (kind === 'basic' && ok && version) state.ymVersion = version;
  writeSaved(state);
}
// Только сведения о прошлых запусках; сами проверки здесь не выполняются.
export async function getDiagnosticsStatus(player: Player) {
  const version = await player.getVersion();
  const state = readSaved();
  return { version, basic: state.basic ?? null, deep: state.deep ?? null };
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
  saveCheck('basic', report.version, ok);
  return { ...report, storedVersion: ok ? report.version : stored, versionChanged: versionChanged && !ok, ok };
}

export interface DeepStep { name: string; ok: boolean; detail: string; }

// Глубокая проверка: реально вставить трек следующим, убедиться, что появился, и убрать.
export async function deepTest(player: Player): Promise<{ ok: boolean; steps: DeepStep[] }> {
  const version = await player.getVersion();
  const steps: DeepStep[] = [];
  const add = (name: string, ok: boolean, detail = ''): void => { steps.push({ name, ok, detail }); };

  let trackId: string | null = null;
  try {
    const t = await player.resolve('Rick Astley Never Gonna Give You Up');
    trackId = t?.id ?? null;
    add('Поиск трека', !!trackId, trackId ? ('id ' + trackId) : 'трек не найден');
  } catch (e) { add('Поиск трека', false, (e as Error).message); }
  if (!trackId) { saveCheck('deep', version, false); return { ok: false, steps }; }

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

  const ok = steps.every((s) => s.ok);
  saveCheck('deep', version, ok);
  return { ok, steps };
}
