// Настройки приложения (app.json в корне): порт панели и параметры оверлея.
// Отдельно от config.json (фильтры заказов), т.к. порт читает и Electron-оболочка.
import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig, OverlayMedia, OverlaySize } from './types.ts';
import { DATA_DIR } from './paths.ts';

const APP_PATH = path.join(DATA_DIR, 'app.json');

const SIZES: OverlaySize[] = ['square', 'slim', 'regular', 'large'];

export const DEFAULT_APP_CONFIG: AppConfig = {
  port: 8620,
  overlay: { media: 'cover', size: 'large', glass: false },
  closeToTray: true,
};

export function normalizeApp(raw: Partial<AppConfig> | null | undefined): AppConfig {
  const r = raw ?? {};
  const port = Number(r.port);
  const media: OverlayMedia = r.overlay?.media === 'videoshot' ? 'videoshot' : 'cover';
  const size: OverlaySize = SIZES.includes(r.overlay?.size as OverlaySize) ? (r.overlay!.size as OverlaySize) : 'large';
  const glass = !!r.overlay?.glass;
  return {
    port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : DEFAULT_APP_CONFIG.port,
    overlay: { media, size, glass },
    closeToTray: r.closeToTray !== false, // по умолчанию true; false только если явно задано
  };
}

export function loadAppConfig(): AppConfig {
  try {
    if (fs.existsSync(APP_PATH)) return normalizeApp(JSON.parse(fs.readFileSync(APP_PATH, 'utf8')));
  } catch (e) {
    console.error('Не удалось прочитать app.json, беру значения по умолчанию:', (e as Error).message);
  }
  return { ...DEFAULT_APP_CONFIG, overlay: { ...DEFAULT_APP_CONFIG.overlay } };
}

export function saveAppConfig(cfg: AppConfig): void {
  try {
    fs.writeFileSync(APP_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  } catch (e) {
    console.error('Не удалось сохранить app.json:', (e as Error).message);
  }
}
