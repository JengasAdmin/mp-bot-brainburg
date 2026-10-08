import { ChannelType, type Client, type Snowflake, ThreadChannel } from "discord.js";
import { prisma } from "../lib/db";
import { logger } from "../lib/logger";
import { baseEmbed, COLORS } from "../lib/embeds";
import { getSettings } from "./settings";
import { formatDateTime } from "../lib/time";

export interface AuditEntry {
  guildId: Snowflake;
  action: string;
  actorId?: Snowflake | null;
  actorTag?: string | null;
  targetType?: string;
  targetId?: string;
  oldValue?: string | null;
  newValue?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown>;
}

const ACTION_RU: Record<string, string> = {
  SETUP_COMPLETED: "Первоначальная настройка сервера",
  EVENT_CREATED: "Создана заявка",
  EVENT_UPDATED: "Заявка изменена",
  EVENT_APPROVED: "Заявка одобрена",
  EVENT_REJECTED: "Заявка отклонена",
  EVENT_REVISION: "Заявка отправлена на доработку",
  EVENT_RESUBMITTED: "Заявка отправлена повторно",
  ORGANIZER_ASSIGNED: "Назначен организатор",
  EVENT_CHANNEL_CREATED: "Создан канал МП",
  EVENT_VOICE_CREATED: "Создан voice-канал МП",
  EVENT_STARTED: "МП запущено",
  EVENT_FINISHED: "МП завершено",
  EVENT_REPORTED: "Отчёт сдан",
  EVENT_ARCHIVED: "МП заархивировано",
  EVENT_CANCELLED: "МП отменено",
  ROLE_CHANGED: "Изменение ролей",
  POSITION_CHANGED: "Кадровое решение (должность)",
  WARNING_ISSUED: "Выдано предупреждение",
  REPRIMAND_ISSUED: "Выдан выговор",
  SANCTION_REMOVED: "Снято взыскание",
  TEST_STARTED: "Начат тест",
  TEST_FINISHED: "Тест завершён",
  TEST_ROLE_GRANTED: "Выдана роль за тест",
  COMMAND_ADMIN: "Административная команда",
  INTERNSHIP_UPDATED: "Изменение стажировки",
  CHANNEL_DELETED: "Канал удалён",
  ACHIEVEMENT_AWARDED: "Выдано достижение",
};

export async function writeAudit(client: Client | null, entry: AuditEntry): Promise<void> {
  try {
    // Гарантируем существование записи пользователя для FK-связи.
    if (entry.actorId) {
      await prisma.user.upsert({
        where: { discordId: entry.actorId },
        create: { discordId: entry.actorId, username: entry.actorTag ?? entry.actorId },
        update: {},
      });
    }
    await prisma.auditLog.create({
      data: {
        guildId: entry.guildId,
        action: entry.action,
        actorId: entry.actorId ?? null,
        actorTag: entry.actorTag ?? null,
        targetType: entry.targetType,
        targetId: entry.targetId,
        oldValue: entry.oldValue ?? null,
        newValue: entry.newValue ?? null,
        reason: entry.reason ?? null,
        metadata: entry.metadata ? JSON.stringify(entry.metadata) : null,
      },
    });
  } catch (err) {
    logger.error("Не удалось записать аудит в БД:", err);
  }

  // Зеркало в Discord-канал логов (не критично при ошибке).
  if (!client) return;
  try {
    const settings = await getSettings(entry.guildId);
    if (!settings.logsChannelId) return;
    const channel = await client.channels.fetch(settings.logsChannelId).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildText) return;

    const embed = baseEmbed(`📜 ${ACTION_RU[entry.action] ?? entry.action}`)
      .setColor(COLORS.SURFACE)
      .addFields(
        { name: "Действие", value: entry.action, inline: true },
        { name: "Пользователь", value: entry.actorTag ? `<@${entry.actorId}>` : entry.actorId ? `<@${entry.actorId}>` : "—", inline: true },
        { name: "Время", value: formatDateTime(new Date()), inline: true }
      );
    if (entry.targetType && entry.targetId) {
      embed.addFields({ name: `Объект (${entry.targetType})`, value: entry.targetId.startsWith("MP-") ? entry.targetId : `<#${entry.targetId}>` });
    }
    if (entry.oldValue) embed.addFields({ name: "Старое значение", value: entry.oldValue.slice(0, 1000) });
    if (entry.newValue) embed.addFields({ name: "Новое значение", value: entry.newValue.slice(0, 1000) });
    if (entry.reason) embed.addFields({ name: "Причина", value: entry.reason.slice(0, 1000) });

    await channel.send({ embeds: [embed] });
  } catch (err) {
    logger.warn("Не удалось отправить запись аудита в канал логов:", err);
  }
}

export async function fetchAudit(guildId: string, limit = 25, action?: string) {
  return prisma.auditLog.findMany({
    where: { guildId, ...(action ? { action } : {}) },
    orderBy: { createdAt: "desc" },
    take: Math.min(limit, 50),
  });
}

export function safeThreadChannel(channel: unknown): ThreadChannel | null {
  return channel instanceof ThreadChannel ? channel : null;
}
