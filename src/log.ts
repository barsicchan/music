// Простое логирование: в файл (logs/brsc-ГГГГ-ММ-ДД.log) и в консоль.
// Помогает отследить, что пошло не так (вход в Twitch, команды чата, заказы, ошибки).
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './paths.ts';

const LOG_DIR = path.join(DATA_DIR, 'logs');

type Level = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

// Кольцевой буфер последних строк лога — для показа в панели.
const RING: string[] = [];
const RING_MAX = 1000;
export function recentLogs(limit = 400): string[] {
  return RING.slice(-Math.max(1, Math.min(limit, RING_MAX)));
}

function ensureDir(): void {
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch { /* ignore */ }
}

// Хранить только последние N файлов-логов (по дням), старые удалять.
const KEEP_FILES = 5;
let pruned = false;
function pruneOldLogs(): void {
  if (pruned) return;
  pruned = true;
  try {
    const files = fs.readdirSync(LOG_DIR)
      .filter((f) => f.startsWith('brsc-') && f.endsWith('.log'))
      .sort(); // по имени = по дате, старые первыми
    for (let i = 0; i < files.length - KEEP_FILES; i++) {
      try { fs.unlinkSync(path.join(LOG_DIR, files[i]!)); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

function fileForToday(): string {
  const day = new Date().toISOString().slice(0, 10);
  return path.join(LOG_DIR, 'brsc-' + day + '.log');
}

function fmtExtra(extra: unknown): string {
  if (extra === undefined) return '';
  if (extra instanceof Error) return ' ' + (extra.stack || extra.message);
  if (typeof extra === 'string') return ' ' + extra;
  try { return ' ' + JSON.stringify(extra); } catch { return ' ' + String(extra); }
}

function write(level: Level, scope: string, msg: string, extra?: unknown): void {
  const line = '[' + new Date().toISOString() + '] [' + level + '] [' + scope + '] ' + msg + fmtExtra(extra);
  // кольцевой буфер
  RING.push(line);
  if (RING.length > RING_MAX) RING.shift();
  // консоль
  if (level === 'ERROR') console.error(line);
  else if (level === 'WARN') console.warn(line);
  else console.log(line);
  // файл
  try {
    ensureDir();
    pruneOldLogs();
    fs.appendFileSync(fileForToday(), line + '\n', 'utf8');
  } catch { /* если файл недоступен — хотя бы консоль */ }
}

export interface Logger {
  debug(msg: string, extra?: unknown): void;
  info(msg: string, extra?: unknown): void;
  warn(msg: string, extra?: unknown): void;
  error(msg: string, extra?: unknown): void;
}

// Создать логгер с фиксированной областью (scope), напр. log('twitch').
export function log(scope: string): Logger {
  return {
    debug: (msg, extra) => write('DEBUG', scope, msg, extra),
    info: (msg, extra) => write('INFO', scope, msg, extra),
    warn: (msg, extra) => write('WARN', scope, msg, extra),
    error: (msg, extra) => write('ERROR', scope, msg, extra),
  };
}

export const LOG_DIR_PATH = LOG_DIR;
