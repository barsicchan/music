// Пути к данным/статике. В dev — рядом с проектом (как и раньше). В упакованном .exe
// Electron задаёт их через env: конфиги/логи пишутся в userData (папка для записи),
// а статика (public) и ассеты лежат в resources (только чтение).
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Корень проекта в dev. В собранном cjs import.meta пуст — но там всегда заданы env-переменные
// (см. || ниже), так что эта ветка не выполняется; try/catch только чтобы не упасть при загрузке.
function devRoot(): string {
  try { return path.join(path.dirname(fileURLToPath(import.meta.url)), '..'); }
  catch { return process.cwd(); }
}

// Куда писать конфиги, логи, состояние (twitch.json, app.json, logs/ и т.д.).
export const DATA_DIR = process.env.BRSC_DATA_DIR || devRoot();
// Откуда читать панель/оверлей/шрифты.
export const PUBLIC_DIR = process.env.BRSC_PUBLIC_DIR || path.join(devRoot(), 'public');
