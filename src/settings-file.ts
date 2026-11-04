// Записываем настройки через временный файл: сбой записи не обрезает старый JSON.
import fs from 'node:fs';
import crypto from 'node:crypto';
export function writeSettings(file: string, contents: string): void {
  // Повреждённый файл не затираем дефолтами, загруженными после ошибки чтения.
  if (fs.existsSync(file)) JSON.parse(fs.readFileSync(file, 'utf8'));
  const tmp = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    fs.writeFileSync(tmp, contents, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(tmp, file);
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}
