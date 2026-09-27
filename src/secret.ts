// Шифрование секретов (токенов Twitch) через Windows DPAPI — ключом текущей учётной записи
// Windows. Расшифровать может только этот же пользователь на этом же компьютере: скопированный
// twitch.json чужому ни к чему. Без зависимостей: зовём встроенный PowerShell
// (System.Security.Cryptography.ProtectedData). Данные идут через stdin/stdout, не через argv.
import { execFileSync } from 'node:child_process';

const PREFIX = 'dpapi:';

function ps(script: string, input: string): string {
  // stderr перехватываем (не сыпать ошибки PowerShell в консоль/лог), при ошибке — ненулевой код → throw
  return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop';" + script], {
    input, encoding: 'utf8', windowsHide: true, timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

const PROTECT =
  'Add-Type -AssemblyName System.Security;' +
  '$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());' +
  "[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser'))";

const UNPROTECT =
  'Add-Type -AssemblyName System.Security;' +
  '$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());' +
  "$o=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser');" +
  '[Console]::Out.Write([Convert]::ToBase64String($o))';

// Зашифровать строку. Бросает, если DPAPI недоступен.
export function protect(plain: string): string {
  return PREFIX + ps(PROTECT, Buffer.from(plain, 'utf8').toString('base64'));
}

// Расшифровать строку из protect(). Бросает при неудаче (другой пользователь / битые данные).
// Туда и обратно гоняем base64 — чтобы кодировка консоли PowerShell не портила UTF-8.
export function unprotect(blob: string): string {
  if (!blob.startsWith(PREFIX)) throw new Error('not a dpapi blob');
  return Buffer.from(ps(UNPROTECT, blob.slice(PREFIX.length)), 'base64').toString('utf8');
}
