// Загрузка/сохранение настроек фильтров из config.json (в корне проекта).
// Файла может не быть — тогда берутся значения по умолчанию.
import fs from 'node:fs';
import path from 'node:path';
import type { FilterConfig } from './types.ts';
import { DATA_DIR } from './paths.ts';

const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

export const DEFAULT_CONFIG: FilterConfig = {
  enabled: true,
  maxDurationSec: 600,   // 10 минут
  maxPerUser: 2,
  maxQueue: 20,
  userCooldownSec: 0,    // 0 = выключено
  allowExplicit: true,
  blockedTrackIds: [],
  blockedArtists: [],
  blockedUsers: [],
  premoderation: false,
  onlyWhenLive: false,
};

// Свести частичный/сырой объект к валидному конфигу поверх дефолтов.
export function normalizeConfig(raw: Partial<FilterConfig> | null | undefined): FilterConfig {
  const r = raw ?? {};
  const numOrNull = (v: unknown, def: number | null): number | null => {
    if (v === null) return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : def;
  };
  const strArr = (v: unknown): string[] =>
    Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];
  return {
    enabled: r.enabled ?? DEFAULT_CONFIG.enabled,
    maxDurationSec: numOrNull(r.maxDurationSec, DEFAULT_CONFIG.maxDurationSec),
    maxPerUser: numOrNull(r.maxPerUser, DEFAULT_CONFIG.maxPerUser),
    maxQueue: numOrNull(r.maxQueue, DEFAULT_CONFIG.maxQueue),
    userCooldownSec: numOrNull(r.userCooldownSec, DEFAULT_CONFIG.userCooldownSec),
    allowExplicit: r.allowExplicit ?? DEFAULT_CONFIG.allowExplicit,
    blockedTrackIds: strArr(r.blockedTrackIds),
    blockedArtists: strArr(r.blockedArtists),
    blockedUsers: strArr(r.blockedUsers).map((s) => s.toLowerCase()),
    premoderation: r.premoderation ?? DEFAULT_CONFIG.premoderation,
    onlyWhenLive: r.onlyWhenLive ?? DEFAULT_CONFIG.onlyWhenLive,
  };
}

export function loadConfig(): FilterConfig {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      return normalizeConfig(raw);
    }
  } catch (e) {
    console.error('Не удалось прочитать config.json, беру значения по умолчанию:', (e as Error).message);
  }
  return { ...DEFAULT_CONFIG };
}

export function saveConfig(cfg: FilterConfig): void {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  } catch (e) {
    console.error('Не удалось сохранить config.json:', (e as Error).message);
  }
}
