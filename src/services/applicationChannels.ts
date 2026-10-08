import { ChannelType, type Client, type Guild, type User, PermissionFlagsBits } from "discord.js";
import type { Event } from "@prisma/client";
import { prisma } from "../lib/db";
import { logger } from "../lib/logger";
import { writeAudit } from "./audit";
import { notifyUser } from "./notifications";
import { statusEmbed } from "../lib/embeds";
import { STATUS } from "../constants";
import { buildReviewEmbed } from "./events";

/**
 * Создаёт приватный канал для заявки на МП.
 * Канал видим только автору заявки и главному организатору.
 */
export async function createApplicationChannel(
  client: Client,
  event: Event,
  author: User
): Promise<string | null> {
  try {
    const guild = await client.guilds.fetch(event.guildId);
    const settings = await prisma.guildSettings.findUnique({
      where: { guildId: event.guildId },
    });

    if (!settings) {
      logger.warn(`Настройки сервера ${event.guildId} не найдены`);
      return null;
    }

    // Находим категорию для каналов заявок (используем категорию проверки)
    const reviewChannel = settings.reviewChannelId
      ? await client.channels.fetch(settings.reviewChannelId).catch(() => null)
      : null;

    const parentId = reviewChannel && "parentId" in reviewChannel
      ? reviewChannel.parentId
      : null;

    // Создаём канал
    const channel = await guild.channels.create({
      name: `📝-${event.code}`,
      type: ChannelType.GuildText,
      parent: parentId,
      topic: `Заявка ${event.code} — ${event.title}`,
      permissionOverwrites: [
        {
          id: guild.roles.everyone.id,
          deny: [PermissionFlagsBits.ViewChannel],
        },
        {
          id: author.id,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
        },
        {
          id: settings.roleHeadOrganizerId ?? "",
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
        },
        {
          id: settings.roleCuratorId ?? "",
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
        },
        {
          id: settings.roleMainAdminId ?? "",
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
        },
      ],
      reason: `Приватный канал заявки ${event.code}`,
    });

    // Сохраняем в БД
    await prisma.applicationChannel.create({
      data: {
        eventId: event.id,
        channelId: channel.id,
        guildId: event.guildId,
        authorId: author.id,
      },
    });

    // Обновляем событие
    await prisma.event.update({
      where: { id: event.id },
      data: { applicationChannelId: channel.id },
    });

    // Отправляем заявку в канал
    const embed = buildReviewEmbed(event as never);
    await channel.send({
      content: `<@${author.id}>`,
      embeds: [embed],
    });

    // Уведомляем автора
    await notifyUser(client, author.id, statusEmbed(
      `📝 Заявка ${event.code} создана`,
      `Ваша заявка «${event.title}» отправлена на проверку.\n` +
      `Канал заявки: <#${channel.id}>`,
      STATUS.PENDING
    ));

    await writeAudit(client, {
      guildId: event.guildId,
      action: "APPLICATION_CHANNEL_CREATED",
      actorId: author.id,
      targetType: "channel",
      targetId: channel.id,
      newValue: event.code,
    });

    logger.info(`Создан приватный канал ${channel.id} для заявки ${event.code}`);
    return channel.id;
  } catch (err) {
    logger.error(`Не удалось создать канал для заявки ${event.code}:`, err);
    return null;
  }
}

/**
 * Уведомляет о статусе заявки (одобрена/отклонена/на доработку).
 */
export async function notifyApplicationStatus(
  client: Client,
  event: Event,
  status: string,
  reviewer: User,
  reason?: string
): Promise<void> {
  const statusLabels: Record<string, string> = {
    [STATUS.APPROVED]: "✅ Одобрена",
    [STATUS.REJECTED]: "❌ Отклонена",
    [STATUS.REVISION]: "✏️ На доработку",
  };

  const statusEmojis: Record<string, string> = {
    [STATUS.APPROVED]: "✅",
    [STATUS.REJECTED]: "❌",
    [STATUS.REVISION]: "✏️",
  };

  const label = statusLabels[status] ?? status;
  const emoji = statusEmojis[status] ?? "📋";

  // Уведомляем автора в ЛМ
  await notifyUser(client, event.authorId, statusEmbed(
    `${emoji} Заявка ${event.code}: ${label}`,
    `Мероприятие «${event.title}»\n` +
    (reason ? `**Причина:** ${reason}\n` : "") +
    `**Проверил:** <@${reviewer.id}>`,
    status as never
  ));

  // Отправляем в приватный канал заявки
  const appChannel = await prisma.applicationChannel.findUnique({
    where: { eventId: event.id },
  });

  if (appChannel) {
    try {
      const channel = await client.channels.fetch(appChannel.channelId);
      if (channel && channel.type === ChannelType.GuildText) {
        await channel.send({
          embeds: [statusEmbed(
            `${emoji} Статус заявки обновлён: ${label}`,
            `Мероприятие «${event.title}»\n` +
            (reason ? `**Причина:** ${reason}\n` : "") +
            `**Проверил:** <@${reviewer.id}>`,
            status as never
          )],
        });
      }
    } catch (err) {
      logger.warn(`Не удалось отправить уведомление в канал заявки ${event.code}:`, err);
    }
  }
}

/**
 * Удаляет приватный канал заявки.
 */
export async function deleteApplicationChannel(
  client: Client,
  eventId: number
): Promise<void> {
  const appChannel = await prisma.applicationChannel.findUnique({
    where: { eventId },
  });

  if (!appChannel) return;

  try {
    const guild = await client.guilds.fetch(appChannel.guildId);
    const channel = await guild.channels.fetch(appChannel.channelId);
    if (channel) {
      await channel.delete(`Заявка ${eventId} закрыта`);
    }
  } catch (err) {
    logger.warn(`Не удалось удалить канал заявки ${eventId}:`, err);
  }

  await prisma.applicationChannel.delete({
    where: { eventId },
  });
}
