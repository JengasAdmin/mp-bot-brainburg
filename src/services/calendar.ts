import { ChannelType, type Client } from "discord.js";
import type { Event, EventCategory } from "@prisma/client";
import { prisma } from "../lib/db";
import { baseEmbed, withFooter } from "../lib/embeds";
import { COLORS, STATUS_RU } from "../constants";
import { formatTime, formatShortDate } from "../lib/time";
import { logger } from "../lib/logger";

// ─────────────────────────── Календарь МП ───────────────────────────

export type EventWithCategory = Event & { category: EventCategory };

export interface CalendarFilters {
  categoryId?: number;
  organizerId?: string;
}

/**
 * Получает мероприятия на неделю (7 дней от сегодня).
 */
export async function getWeeklyCalendar(
  guildId: string,
  filters: CalendarFilters = {}
): Promise<EventWithCategory[]> {
  const now = new Date();
  const weekLater = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  return prisma.event.findMany({
    where: {
      guildId,
      status: { in: ["APPROVED", "PLANNED", "ACTIVE"] },
      scheduledAt: { gte: now, lte: weekLater },
      ...(filters.categoryId ? { categoryId: filters.categoryId } : {}),
      ...(filters.organizerId ? { organizerId: filters.organizerId } : {}),
    },
    orderBy: { scheduledAt: "asc" },
    include: { category: true },
  });
}

/**
 * Группирует мероприятия по дням.
 */
export function groupEventsByDay(events: EventWithCategory[]): Map<string, EventWithCategory[]> {
  const groups = new Map<string, EventWithCategory[]>();

  for (const event of events) {
    const dateKey = event.scheduledAt.toISOString().split("T")[0];
    if (!groups.has(dateKey)) {
      groups.set(dateKey, []);
    }
    groups.get(dateKey)!.push(event);
  }

  return groups;
}

/**
 * Создаёт embed с календарём МП на неделю.
 */
export function buildCalendarEmbed(
  events: EventWithCategory[],
  guildName: string,
  filters: CalendarFilters = {}
): ReturnType<typeof baseEmbed> {
  const grouped = groupEventsByDay(events);
  const filterDesc: string[] = [];

  if (filters.categoryId) {
    const category = events.find((e) => e.categoryId === filters.categoryId)?.category;
    if (category) filterDesc.push(`Категория: ${category.emoji} ${category.name}`);
  }
  if (filters.organizerId) {
    filterDesc.push(`Организатор: <@${filters.organizerId}>`);
  }

  const embed = baseEmbed("📅 Календарь мероприятий на неделю")
    .setColor(COLORS.INFO)
    .setDescription(
      events.length === 0
        ? "На этой неделе мероприятий нет."
        : `Всего мероприятий: **${events.length}**`
    );

  if (filterDesc.length > 0) {
    embed.addFields({ name: "🔍 Фильтры", value: filterDesc.join("\n") });
  }

  // Группируем по дням
  const dayNames = ["Воскресенье", "Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота"];
  const monthNames = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];

  for (const [dateKey, dayEvents] of grouped) {
    const date = new Date(dateKey);
    const dayName = dayNames[date.getDay()];
    const dateStr = `${date.getDate()} ${monthNames[date.getMonth()]}`;

    const eventsList = dayEvents
      .map((e) => {
        const meta = STATUS_RU[e.status];
        const time = formatTime(e.scheduledAt);
        const category = e.category ? `${e.category.emoji} ` : "";
        return `• **${time}** — ${category}**${e.title}** ${meta.emoji} — \`${e.code}\` — <@${e.organizerId ?? e.authorId}>`;
      })
      .join("\n");

    embed.addFields({
      name: `📆 ${dayName}, ${dateStr}`,
      value: eventsList,
    });
  }

  embed.setFooter({ text: `Сервер: ${guildName} • Обновляется автоматически` });
  return withFooter(embed);
}

/**
 * Обновляет панель календаря (борд).
 */
export async function updateCalendarBoard(
  client: Client,
  guildId: string,
  guildName: string
): Promise<void> {
  try {
    const events = await getWeeklyCalendar(guildId);
    const embed = buildCalendarEmbed(events, guildName);

    const settings = await prisma.guildSettings.findUnique({
      where: { guildId },
    });

    if (!settings?.planningChannelId) return;

    const channel = await client.channels.fetch(settings.planningChannelId).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildText) return;

    const board = await prisma.boardMessage.findUnique({
      where: { guildId_key: { guildId, key: "CALENDAR" } },
    });

    if (board) {
      const message = await channel.messages.fetch(board.messageId).catch(() => null);
      if (message) {
        await message.edit({ embeds: [embed] });
        return;
      }
      await prisma.boardMessage.delete({ where: { id: board.id } }).catch(() => null);
    }

    const message = await channel.send({ embeds: [embed] });
    await prisma.boardMessage.create({
      data: { guildId, key: "CALENDAR", channelId: channel.id, messageId: message.id },
    });
  } catch (err) {
    logger.warn("Не удалось обновить панель календаря:", err);
  }
}
