import type { Client } from "discord.js";
import { config } from "../config";
import { logger } from "../lib/logger";
import {
  autoArchiveReported,
  autoStartDueEvents,
  cleanupExpiredVoiceChannels,
  notifyUpcomingEvents,
  remindOverdueReports,
  updateActiveBoard,
  updatePlanningBoard,
  updateStatsBoard,
} from "../services/events";
import { expireStaleAttempts } from "../services/tests";
import { pingUpcomingEvents } from "../services/ping";

let timer: NodeJS.Timeout | null = null;
let running = false;
let ticksSinceBoards = 0;

/// Один тик планировщика. Задачи идут последовательно и изолированно:
/// сбой одного guild-прохода не останавливает остальные.
/// Повторный запуск во время выполняющегося тика отсекается флагом running —
/// защита от «двойного клика» при ресете интервала и рестартах.
export async function runSchedulerTick(client: Client): Promise<void> {
  if (running) {
    logger.debug("Планировщик: предыдущий тик ещё выполняется, пропуск");
    return;
  }
  running = true;
  const startedAt = Date.now();
  try {
    const guildIds = [...client.guilds.cache.keys()];
    for (const guildId of guildIds) {
      try {
        await autoStartDueEvents(client, guildId);
        await notifyUpcomingEvents(client, guildId, config.scheduler.reminderMinutesAhead);
        await pingUpcomingEvents(client, guildId, config.scheduler.reminderMinutesAhead);
        await remindOverdueReports(client, guildId, config.scheduler.reportReminderMax);
        await autoArchiveReported(client, guildId, config.scheduler.autoArchiveDays);
        await cleanupExpiredVoiceChannels(client, guildId, config.scheduler.voiceCleanupDelayMinutes);
      } catch (err) {
        logger.error(`Планировщик: задачи для guild ${guildId} прерваны:`, err);
      }
    }

    // Просроченные попытки тестов — глобальная задача, не привязана к guild.
    try {
      const expired = await expireStaleAttempts();
      if (expired > 0) logger.info(`Планировщик: истекло попыток тестов — ${expired}`);
    } catch (err) {
      logger.error("Планировщик: expireStaleAttempts не удался:", err);
    }

    // Периодическая перестройка панелей (данные всегда читаются из БД).
    ticksSinceBoards++;
    if (ticksSinceBoards >= config.scheduler.boardsEveryTicks) {
      ticksSinceBoards = 0;
      await refreshBoards(client);
    }
  } finally {
    running = false;
    logger.debug(`Планировщик: тик завершён за ${Date.now() - startedAt} мс`);
  }
}

/// Перестройка всех панелей по данным из БД (идемпотентно).
export async function refreshBoards(client: Client): Promise<void> {
  for (const guild of client.guilds.cache.values()) {
    try {
      await updatePlanningBoard(client, guild.id);
      await updateActiveBoard(client, guild.id);
      await updateStatsBoard(client, guild.id, guild.name);
    } catch (err) {
      logger.warn(`Не удалось обновить панели guild ${guild.id}:`, err);
    }
  }
}

export function startScheduler(client: Client): void {
  if (timer) return;
  timer = setInterval(() => {
    void runSchedulerTick(client);
  }, config.scheduler.tickMs);
  timer.unref();
  logger.info(`Планировщик запущен (интервал ${Math.round(config.scheduler.tickMs / 1000)} с)`);
}

export function stopScheduler(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  logger.info("Планировщик остановлен");
}
