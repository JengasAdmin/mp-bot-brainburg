import { ChannelType, type Client } from "discord.js";
import { prisma } from "../lib/db";
import { logger } from "../lib/logger";
import { writeAudit } from "./audit";
import { statusEmbed } from "../lib/embeds";
import { STATUS } from "../constants";
import { formatDateTime } from "../lib/time";

/**
 * Отправляет @here в каналы мероприятий, до которых осталось N минут.
 * Повторно не отправляется (pingNotifiedAt хранится в БД).
 */
export async function pingUpcomingEvents(
  client: Client,
  guildId: string,
  minutesAhead: number
): Promise<number> {
  const now = new Date();
  const horizon = new Date(now.getTime() + minutesAhead * 60_000);

  const upcoming = await prisma.event.findMany({
    where: {
      guildId,
      status: { in: [STATUS.APPROVED, STATUS.PLANNED] },
      scheduledAt: { gte: now, lte: horizon },
      pingNotifiedAt: null,
    },
    include: { category: true },
  });

  let pinged = 0;

  for (const event of upcoming) {
    try {
      // Отправляем в канал мероприятия, если он существует
      if (event.eventChannelId) {
        const channel = await client.channels.fetch(event.eventChannelId).catch(() => null);
        if (channel && channel.type === ChannelType.GuildText) {
          await channel.send({
            content: "@here",
            embeds: [statusEmbed(
              `🔔 МП начинается через ${minutesAhead} минут!`,
              `**${event.title}** (${event.code})\n` +
              `Начало: ${formatDateTime(event.scheduledAt)}\n` +
              `Организатор: <@${event.organizerId ?? event.authorId}>`,
              STATUS.PLANNED
            )],
          });
        }
      }

      // Отмечаем, что уведомление отправлено
      await prisma.event.update({
        where: { id: event.id },
        data: { pingNotifiedAt: new Date() },
      });

      await writeAudit(client, {
        guildId,
        action: "EVENT_PING_SENT",
        targetType: "event",
        targetId: event.code,
        newValue: `@here за ${minutesAhead} мин`,
      });

      pinged++;
    } catch (err) {
      logger.warn(`Не удалось отправить @here для ${event.code}:`, err);
    }
  }

  if (pinged > 0) {
    logger.info(`Отправлено @here для ${pinged} мероприятий`);
  }

  return pinged;
}
