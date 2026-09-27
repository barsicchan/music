#!/usr/bin/env node
// Точка входа прототипа: поднять клиент ЯМ, подключиться, запустить панель управления.
import { exec } from 'node:child_process';
import { Player } from './player.ts';
import { RequestManager } from './requests.ts';
import { TwitchController } from './twitch.ts';
import { startServer } from './server.ts';
import { getStoredVersion } from './diagnostics.ts';
import { loadAppConfig } from './appconfig.ts';
import { log, LOG_DIR_PATH } from './log.ts';

const appConfig = loadAppConfig();
const PORT_CDP = Number(process.env.YM_CDP_PORT ?? 9222);
const PORT_HTTP = Number(process.env.PORT ?? appConfig.port);
const OPEN_BROWSER = process.argv.includes('--open') || process.env.BRSC_OPEN === '1';
const logger = log('app');

process.on('uncaughtException', (e) => logger.error('uncaughtException', e));
process.on('unhandledRejection', (e) => logger.error('unhandledRejection', e));

async function main(): Promise<void> {
  logger.info('старт прототипа');
  console.log('▶ brsc / music — панель для Яндекс Музыки');
  console.log('  Подключаюсь к клиенту (CDP :' + PORT_CDP + ')…');

  const player = new Player({ port: PORT_CDP });
  await player.connect();
  logger.info('подключено к плееру ЯМ (CDP :' + PORT_CDP + ')');
  console.log('  ✓ Подключено к плееру.');

  // проверка смены версии клиента ЯМ (после обновления что-то могло сломаться)
  try {
    const version = await player.getVersion();
    const stored = getStoredVersion();
    if (version && stored && version !== stored) {
      logger.warn('версия клиента ЯМ изменилась: ' + stored + ' → ' + version + ' — рекомендуется диагностика (вкладка «Диагностика»)');
      console.log('  ⚠ Клиент ЯМ обновился (' + stored + ' → ' + version + '). Проверьте вкладку «Диагностика».');
    } else if (version) {
      logger.info('версия клиента ЯМ: ' + version + (stored ? '' : ' (первый запуск)'));
    }
  } catch { /* не критично */ }

  const requests = new RequestManager(player);
  const twitch = new TwitchController(player, requests);
  await twitch.init();
  await startServer({ player, requests, twitch, port: PORT_HTTP });

  const url = 'http://127.0.0.1:' + PORT_HTTP;
  if (OPEN_BROWSER) {
    try { exec('start "" "' + url + '"'); } catch { /* не критично */ }
  }
  logger.info('сервер панели запущен: ' + url);

  console.log('');
  console.log('  🎛  Панель управления:  ' + url);
  console.log('  📄 Логи:                ' + LOG_DIR_PATH);
  console.log('  Ctrl+C — выход (клиент ЯМ продолжит работать).');
}

main().catch((e: unknown) => {
  logger.error('ошибка запуска', e);
  console.error('✗ Ошибка запуска:', (e as Error).message);
  console.error('  Подсказка: убедитесь, что клиент ЯМ установлен. Прототип сам запустит его с отладкой.');
  process.exit(1);
});
