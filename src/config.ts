import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Отсутствует обязательная переменная окружения ${name}. Заполните .env (пример — .env.example).`
    );
  }
  return value;
}

function int(name: string, fallback: number, min = 1): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < min) {
    throw new Error(`Переменная ${name} должна быть целым числом не меньше ${min}, получено: ${raw}`);
  }
  return value;
}

export const config = {
  discordToken: required("DISCORD_TOKEN"),
  guildId: process.env.GUILD_ID || null,
  /// ID «официального» сервера, где проходят МП (необязателен).
  /// Если задан и бот приглашён туда — каналы мероприятий создаются там.
  officialGuildId: process.env.OFFICIAL_GUILD_ID || null,
  /// Webhook для анонсов МП на официальном сервере (необязателен).
  /// Приоритет: настройка в БД (announceWebhookUrl) → эта переменная →
  /// тестовый канал сервера организаторов (announceChannelId).
  announceWebhookUrl: process.env.ANNOUNCE_WEBHOOK_URL || null,
  /// Параметры планировщика (все опциональны, значения по умолчанию — в .env.example).
  scheduler: {
    /// Как часто выполняется тик планировщика, мс.
    tickMs: int("SCHEDULER_TICK_MS", 60_000, 5_000),
    /// За сколько минут до МП отправляется напоминание.
    reminderMinutesAhead: int("REMINDER_MINUTES_AHEAD", 60, 1),
    /// Максимум напоминаний о просроченном отчёте.
    reportReminderMax: int("REPORT_REMINDER_MAX", 3, 1),
    /// Через сколько дней REPORTED уходит в архив автоматически.
    autoArchiveDays: int("AUTO_ARCHIVE_DAYS", 7, 1),
    /// Через сколько минут после завершения удаляется голосовой канал.
    voiceCleanupDelayMinutes: int("VOICE_CLEANUP_DELAY_MINUTES", 30, 1),
    /// Как часто (в тиках) перестраиваются информационные панели.
    boardsEveryTicks: int("BOARDS_EVERY_TICKS", 15, 1),
  },
} as const;
