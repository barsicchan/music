// Общие типы данных прототипа.

export interface PlayerState {
  title: string | null;
  artist: string | null;
  cover?: string | null;
  playbackState: string;
  position?: number;
  duration?: number;
  status?: string;
  contextType?: string;
  contextId?: string;
  volume?: number;
  queueLen?: number;
  index?: number;
  currentId?: string | null;
  color?: string | null; // акцентный цвет обложки (hex, derivedColors.average)
  videoShot?: string | null; // прямой mp4-луп (видеошот), если есть у трека
  liked?: boolean | null; // лайкнут ли текущий трек (по кнопке ЯМ); null = неизвестно
}

export type OverlayMedia = 'cover' | 'videoshot';
export type OverlaySize = 'square' | 'slim' | 'regular' | 'large';
export interface OverlayConfig {
  media: OverlayMedia; // что показывать в слоте обложки оверлея
  size: OverlaySize;   // размер виджета (URL фиксированный, размер правится тут)
  glass: boolean;      // режим «жидкое стекло» (полупрозрачная стеклянная плашка)
}
export interface AppConfig {
  port: number;           // порт HTTP-панели/оверлея (нужен фиксированный для OBS)
  overlay: OverlayConfig;
  closeToTray: boolean;   // крестик сворачивает в трей (true, по умолчанию) или закрывает (false)
}

export interface DiagCheck {
  name: string;
  ok: boolean;
  detail: string;
}
export interface DiagReport {
  version: string | null;
  checks: DiagCheck[];
  passed: number;
  total: number;
}

export interface QueueItem {
  pos: number;
  id: string | null;
  title: string | null;
  artist?: string | null;
  isCurrent: boolean;
  by?: string; // ник заказчика, если это заказной трек
}

export interface QueueSnapshot {
  index: number | undefined;
  total: number;
  items: QueueItem[];
}

export interface ResolvedTrack {
  id: string;
  title: string | null;
  artist: string | null;
  source?: 'id' | 'url' | 'search';
  durationSec?: number | null;
  explicit?: boolean;
  available?: boolean;
  artistIds?: string[];
}

export type RequestStatus = 'queued' | 'pending' | 'played' | 'cancelled' | 'rejected';

export interface RequestRecord {
  id: string;
  title: string | null;
  artist: string | null;
  source?: string;
  user: string;
  at: string;
  position?: number;
  durationSec?: number | null;
  status: RequestStatus;
}

// Код причины (для выбора шаблона ответа бота).
export type RejectCode =
  | 'empty' | 'notFound' | 'duplicate' | 'disabled' | 'blockedUser'
  | 'blockedTrack' | 'blockedArtist' | 'unavailable' | 'explicit'
  | 'tooLong' | 'maxUser' | 'maxQueue' | 'cooldown' | 'offline' | 'error';

export interface SubmitResult {
  ok: boolean;
  request?: RequestRecord;
  error?: string;
  code?: RejectCode;      // причина отказа (при ok=false)
  duplicate?: boolean;
  pending?: boolean;      // заказ ушёл на премодерацию, а не в очередь
  // значения для подстановки в шаблоны ответов
  vars?: Record<string, string | number>;
}

// Одна команда чата (напр. !song). Ключом служит id команды (song, skip, …).
export interface BotCommand {
  trigger: string;   // текст команды, напр. "!song"
  enabled: boolean;
  minLevel: number;  // минимальный уровень зрителя (0..4, см. LEVEL в twitch-chat)
}

// Настройки бота: команды + шаблоны ответов (файл bot.json, правится в панели).
export interface BotConfig {
  commands: Record<string, BotCommand>;
  responses: Record<string, string>;
  votesNeeded: number; // сколько голосов для !voteskip
}

// Один авторизованный Twitch-аккаунт (основной или бот).
export interface TwitchAccount {
  login: string;
  userId: string; // twitch user_id (для API, напр. проверки фолловеров)
  accessToken: string;
  refreshToken: string;
  expiresAt?: number; // когда протухнет access-токен (ms epoch) — показываем в панели
}

export type ReplyWith = 'main' | 'bot';

// Настройки интеграции с Twitch (файл twitch.json; токены хранятся локально).
export interface TwitchConfig {
  enabled: boolean;       // подключаться к чату
  clientId: string;       // Client ID своего Twitch-приложения (для входа)
  channel: string;        // канал, чей чат читаем (по умолчанию = логин основного)
  command: string;        // команда заказа, напр. "!sr"
  announce: boolean;      // отвечать заказчику в чат
  replyWith: ReplyWith;   // от чьего имени отвечать: основной аккаунт или бот
  main: TwitchAccount;    // основной аккаунт (канал)
  bot: TwitchAccount;     // бот-аккаунт (необязательно)
}

export interface TwitchStatus {
  configured: boolean;      // заданы clientId и есть канал
  enabled: boolean;
  connected: boolean;       // IRC-чат подключён
  channel: string;
  clientId: string;         // не секрет — отдаём для заполнения формы
  command: string;
  announce: boolean;
  replyWith: ReplyWith;
  mainLogin: string | null; // логин основного аккаунта (если вошёл)
  botLogin: string | null;  // логин бот-аккаунта (если вошёл)
  mainExpiresAt?: number | null; // срок действия токена основного (ms epoch)
  botExpiresAt?: number | null;  // срок действия токена бота (ms epoch)
  activeLogin: string | null; // от чьего имени сейчас отвечаем/подключены
  awaitingAuth: boolean;    // идёт ожидание подтверждения входа
  awaitingWhich?: ReplyWith; // какой аккаунт входит
  authUrl?: string;         // ссылка авторизации Twitch (запасной вариант, если браузер не открылся)
  error?: string | null;
}

// Настройки приёма заказов. Все поля правятся на лету (панель / config.json).
// null у числовых лимитов = ограничение выключено.
export interface FilterConfig {
  enabled: boolean;             // приём заказов включён
  maxDurationSec: number | null; // лимит длительности трека
  maxPerUser: number | null;     // сколько активных заказов держит один зритель
  maxQueue: number | null;       // максимум активных заказов всего
  userCooldownSec: number | null;// пауза между заказами одного зрителя
  allowExplicit: boolean;        // разрешать explicit-треки
  blockedTrackIds: string[];     // чёрный список треков (по id)
  blockedArtists: string[];      // чёрный список артистов (по имени, регистр не важен)
  blockedUsers: string[];        // забаненные заказчики (ник в нижнем регистре)
  premoderation: boolean;        // заказ ждёт подтверждения перед постановкой (по умолчанию выкл)
  onlyWhenLive: boolean;         // принимать заказы только когда стрим онлайн
}
