// Twitch OAuth 2.0 Implicit Grant Flow — вход без секрета (public client).
// Client ID встроен (см. twitch.ts). Пользователь жмёт «Войти» → открывается браузер
// со страницей Twitch → «Authorize» → редирект на локальный колбэк, откуда мы забираем токен. Refresh-токена в implicit нет —
// когда токен протухнет (у Twitch это ~месяц для чат-скоупов), нужен повторный вход.
const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const VALIDATE_URL = 'https://id.twitch.tv/oauth2/validate';
const AUTHORIZE_URL = 'https://id.twitch.tv/oauth2/authorize';

// chat:* — читать/писать в чат; moderator:read:followers — определять фолловеров.
export const SCOPES = 'chat:read chat:edit moderator:read:followers';

export interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

const form = (obj: Record<string, string>): string => new URLSearchParams(obj).toString();

// Собрать ссылку на страницу авторизации Twitch (implicit flow).
// redirectUri должен ТОЧНО совпадать с зарегистрированным в приложении на dev.twitch.tv.
// force_verify=true — Twitch всегда показывает экран подтверждения (удобно для входа ботом).
export function buildAuthorizeUrl(clientId: string, redirectUri: string, state: string): string {
  return AUTHORIZE_URL + '?' + form({
    response_type: 'token',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: SCOPES,
    state,
    force_verify: 'true',
  });
}

// Проверить токен и заодно узнать логин/user_id аккаунта.
export async function validate(accessToken: string): Promise<{ login: string; user_id: string; scopes: string[]; expires_in: number }> {
  const r = await fetch(VALIDATE_URL, { headers: { Authorization: 'OAuth ' + accessToken } });
  if (!r.ok) throw new Error('validate failed: ' + r.status);
  return (await r.json()) as { login: string; user_id: string; scopes: string[]; expires_in: number };
}

// Проверить, фолловит ли пользователь канал (Helix). Нужен токен канала (main) со scope
// moderator:read:followers и Client ID. Возвращает true/false, либо null при ошибке.
export async function isFollower(
  clientId: string, broadcasterToken: string, broadcasterId: string, userId: string,
): Promise<boolean | null> {
  try {
    const url = 'https://api.twitch.tv/helix/channels/followers?broadcaster_id=' +
      encodeURIComponent(broadcasterId) + '&user_id=' + encodeURIComponent(userId);
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + broadcasterToken, 'Client-Id': clientId } });
    if (!r.ok) return null;
    const j = (await r.json()) as { data?: unknown[] };
    return Array.isArray(j.data) && j.data.length > 0;
  } catch { return null; }
}

// Онлайн ли стрим (Helix Get Streams). Нужен любой валидный токен + Client ID.
export async function getStreamLive(clientId: string, token: string, userId: string): Promise<boolean | null> {
  try {
    const url = 'https://api.twitch.tv/helix/streams?user_id=' + encodeURIComponent(userId);
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token, 'Client-Id': clientId } });
    if (!r.ok) return null;
    const j = (await r.json()) as { data?: unknown[] };
    return Array.isArray(j.data) && j.data.length > 0;
  } catch { return null; }
}

// Обновить токен по refresh-токену (public client — без секрета).
export async function refresh(clientId: string, refreshToken: string): Promise<Tokens> {
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error('Не удалось обновить токен (' + r.status + '): ' + text.slice(0, 200));
  return JSON.parse(text) as Tokens;
}
