import type { Client } from "discord.js";
import { logger } from "../lib/logger";
import { restoreEventChannels } from "../services/events";
import { refreshBoards, runSchedulerTick } from "./index";

/// Восстановление после рестарта: все состояния хранятся в БД, здесь мы
/// только заново связываем Discord-объекты (каналы, голосовые, панели)
/// и запускаем первый тик планировщика, чтобы пропущенные события
/// (автозапуск, напоминания) догнали расписание.
export async function runRecovery(client: Client): Promise<void> {
  const guilds = [...client.guilds.cache.values()];
  if (guilds.length === 0) {
    logger.warn("Восстановление: бот не состоит ни на одном сервере");
    return;
  }

  for (const guild of guilds) {
    try {
      const restored = await restoreEventChannels(client, guild.id);
      if (restored > 0) logger.info(`Восстановление ${guild.name}: пересоздано каналов — ${restored}`);
    } catch (err) {
      logger.error(`Восстановление каналов guild ${guild.id} не удалось:`, err);
    }
  }

  await refreshBoards(client);

  try {
    await runSchedulerTick(client);
    logger.info("Восстановление завершено: первый тик планировщика выполнен");
  } catch (err) {
    logger.error("Первый тик планировщика после рестарта не удался:", err);
  }
}
