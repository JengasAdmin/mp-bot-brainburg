import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  WebhookClient,
  type Client,
  type EmbedBuilder,
} from "discord.js";
import type { GuildSettings } from "@prisma/client";
import { prisma } from "../lib/db";
import { logger } from "../lib/logger";
import { config } from "../config";
import { baseEmbed, COLORS, withFooter } from "../lib/embeds";
import { STATUS } from "../constants";
import { discordTimestamp, formatDateTime, formatDuration } from "../lib/time";
import type { EventWithCategory } from "./events";
import { getSettings } from "./settings";

/// Мост анонсов МП: при планировании/запуске/завершении бот публикует
/// приглашение в тестовый канал сервера организаторов (или в webhook
/// официального сервера, если он настроен). Записи «✅ Буду» хранятся в БД.

export type AnnounceKind = "SCHEDULED" | "STARTED" | "FINISHED" | "CANCELLED";

type AnnouncePayload = { embeds: EmbedBuilder[]; components?: ActionRowBuilder<ButtonBuilder>[] };

interface ChannelTarget { type: "channel"; channelId: string }
interface WebhookTarget { type: "webhook"; url: string }
type AnnounceTarget = ChannelTarget | WebhookTarget;

/// Куда публиковать: webhook (БД → env) имеет приоритет над тестовым каналом.
function resolveTarget(settings: GuildSettings): AnnounceTarget | null {
  const url = settings.announceWebhookUrl || config.announceWebhookUrl;
  if (url) return { type: "webhook", url };
  if (settings.announceChannelId) return { type: "channel", channelId: settings.announceChannelId };
  return null;
}

// ─────────────────────────── Построение embed ───────────────────────────

function signupRow(eventId: number): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`mp:join:${eventId}`)
        .setLabel("Записаться")
        .setEmoji("✅")
        .setStyle(ButtonStyle.Success)
    ),
  ];
}

function feedbackRow(eventId: number): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      ...[1, 2, 3, 4, 5].map((score) =>
        new ButtonBuilder()
          .setCustomId(`fb:score:${eventId}:${score}`)
          .setLabel(String(score))
          .setEmoji("⭐")
          .setStyle(score >= 4 ? ButtonStyle.Success : score === 3 ? ButtonStyle.Secondary : ButtonStyle.Danger)
      )
    ),
  ];
}

export async function buildAnnounce(
  client: Client,
  event: EventWithCategory,
  kind: AnnounceKind
): Promise<{ embed: EmbedBuilder; components: ActionRowBuilder<ButtonBuilder>[] }> {
  const organizer = event.organizerId ?? event.authorId;
  const base = baseEmbed();

  if (kind === "SCHEDULED") {
    const count = await prisma.eventSignup.count({ where: { eventId: event.id } });
    base
      .setTitle(`📅 МП «${event.title}»`)
      .setColor(COLORS.INFO)
      .setDescription(event.description.slice(0, 2000))
      .addFields(
        { name: "🗓 Когда", value: `${formatDateTime(event.scheduledAt)} (${discordTimestamp(event.scheduledAt, "f")})`, inline: true },
        { name: "⏱ Длительность", value: formatDuration(event.durationMinutes), inline: true },
        { name: "📍 Место", value: event.location ?? "уточняется", inline: true },
        { name: "🎭 Категория", value: `${event.category.emoji} ${event.category.name}`, inline: true },
        { name: "🎯 Организатор", value: `<@${organizer}>`, inline: true },
        { name: "👥 Записались", value: String(count), inline: true }
      );
    return { embed: withFooter(base), components: signupRow(event.id) };
  }

  if (kind === "STARTED") {
    const link = await eventChannelLink(client, event);
    base
      .setTitle(`▶️ МП началось — «${event.title}»`)
      .setColor(COLORS.SUCCESS)
      .setDescription(
        [
          `Мероприятие **${event.code}** уже идёт — присоединяйтесь!`,
          link ? `Канал проведения: ${link}` : "",
          `Организатор: <@${organizer}>`,
        ]
          .filter(Boolean)
          .join("\n")
      );
    return { embed: withFooter(base), components: [] };
  }

  if (kind === "FINISHED") {
    base
      .setTitle(`🏁 МП завершено — «${event.title}»`)
      .setColor(COLORS.TEXT_MUTED)
      .setDescription(
        [
          `Спасибо всем, кто участвовал! Мероприятие **${event.code}** завершено.`,
          `Организатор: <@${organizer}>`,
          "",
          "**Оцените мероприятие от 1 до 5 звёзд:**",
        ].join("\n")
      );
    return { embed: withFooter(base), components: feedbackRow(event.id) };
  }

  // CANCELLED
  base
    .setTitle(`🚫 МП отменено — «${event.title}»`)
    .setColor(COLORS.DANGER)
    .setDescription(
      [
        `Мероприятие **${event.code}** (${formatDateTime(event.scheduledAt)}) отменено.`,
        event.cancelReason ? `**Причина:** ${event.cancelReason}` : "",
      ]
        .filter(Boolean)
        .join("\n")
    );
  return { embed: withFooter(base), components: [] };
}

async function eventChannelLink(client: Client, event: EventWithCategory): Promise<string | null> {
  if (!event.eventChannelId) return null;
  const channel = await client.channels.fetch(event.eventChannelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText || !channel.guildId) return null;
  return `https://discord.com/channels/${channel.guildId}/${channel.id}`;
}

// ─────────────────────────── Доставка ───────────────────────────

async function editViaChannel(client: Client, channelId: string, messageId: string, payload: AnnouncePayload): Promise<boolean> {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (channel?.type !== ChannelType.GuildText) return false;
  const message = await channel.messages.fetch(messageId).catch(() => null);
  if (!message) return false;
  await message.edit(payload);
  return true;
}

async function editViaWebhook(url: string, messageId: string, payload: AnnouncePayload): Promise<boolean> {
  const webhook = new WebhookClient({ url });
  try {
    const message = await webhook.fetchMessage(messageId).catch(() => null);
    if (!message) return false;
    await webhook.editMessage(messageId, payload);
    return true;
  } finally {
    webhook.destroy();
  }
}

/// Публикует/обновляет анонс. Возвращает true, если сообщение доставлено.
export async function postAnnouncement(
  client: Client,
  event: EventWithCategory,
  kind: AnnounceKind
): Promise<boolean> {
  try {
    const settings = await getSettings(event.guildId);
    const built = await buildAnnounce(client, event, kind);
    const payload: AnnouncePayload = { embeds: [built.embed], components: built.components };

    // 1) Обновление ранее опубликованного сообщения (если оно ещё живо).
    if (event.announceMessageId) {
      if (event.announceChannelId && (await editViaChannel(client, event.announceChannelId, event.announceMessageId, payload).catch(() => false))) {
        return true;
      }
      const url = settings.announceWebhookUrl || config.announceWebhookUrl;
      if (url && (await editViaWebhook(url, event.announceMessageId, payload).catch(() => false))) {
        return true;
      }
    }

    // 2) Публикация нового сообщения.
    const target = resolveTarget(settings);
    if (!target) {
      logger.debug(`Анонс ${event.code} (${kind}) пропущен: канал/webhook не настроены.`);
      return false;
    }

    if (target.type === "webhook") {
      const webhook = new WebhookClient({ url: target.url });
      try {
        const sent = await webhook.send({ ...payload, username: `МП ${event.code}` });
        await prisma.event.update({
          where: { id: event.id },
          data: { announceMessageId: sent.id, announceChannelId: null },
        });
        return true;
      } finally {
        webhook.destroy();
      }
    }

    const channel = await client.channels.fetch(target.channelId).catch(() => null);
    if (channel?.type !== ChannelType.GuildText) {
      logger.warn(`Канал анонсов ${target.channelId} недоступен — анонс ${event.code} не опубликован.`);
      return false;
    }
    const sent = await channel.send(payload);
    await prisma.event.update({
      where: { id: event.id },
      data: { announceMessageId: sent.id, announceChannelId: channel.id },
    });
    return true;
  } catch (err) {
    logger.warn(`Не удалось опубликовать анонс ${event.code} (${kind}):`, err);
    return false;
  }
}

// ─────────────────────────── Записи «Буду» ───────────────────────────

export interface SignupResult {
  joined: boolean;
  count: number;
}

/// Переключает запись участника на МП и обновляет счётчик в анонсе.
export async function toggleSignup(client: Client, event: EventWithCategory, userId: string): Promise<SignupResult> {
  const key = { eventId: event.id, userId };
  const existing = await prisma.eventSignup.findUnique({ where: { eventId_userId: key } });
  if (existing) {
    await prisma.eventSignup.delete({ where: { id: existing.id } }).catch(() => undefined);
  } else {
    await prisma.eventSignup.create({ data: key }).catch(() => undefined);
  }
  const count = await prisma.eventSignup.count({ where: { eventId: event.id } });

  // Обновляем счётчик в опубликованном анонсе (best-effort).
  if (event.status === STATUS.APPROVED || event.status === STATUS.PLANNED) {
    await postAnnouncement(client, event, "SCHEDULED");
  }
  return { joined: !existing, count };
}

export async function getSignupCount(eventId: number): Promise<number> {
  return prisma.eventSignup.count({ where: { eventId } });
}
