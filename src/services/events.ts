import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  type Client,
  EmbedBuilder,
  type Snowflake,
  type User,
} from "discord.js";
import type { Event, EventCategory, EventReport, GuildSettings } from "@prisma/client";
import { prisma } from "../lib/db";
import { UserError } from "../lib/errors";
import { baseEmbed, COLORS, infoEmbed, statusEmbed, withFooter } from "../lib/embeds";
import { STATUS, STATUS_RU } from "../constants";
import { discordTimestamp, formatDateTime, formatShortDate, formatTime } from "../lib/time";
import { logger } from "../lib/logger";
import { writeAudit } from "./audit";
import { notifyUser } from "./notifications";
import { getSettings, requireChannel } from "./settings";
import { buildOverwrites, resolveRoleSet } from "../permissions/channelAccess";
import { evaluateAchievements } from "./achievements";
import { statsBoardEmbed } from "./stats";
import { awardEventPoints, checkRatingBadges } from "./rating";
import { createApplicationChannel, notifyApplicationStatus } from "./applicationChannels";
import { assertChecklistComplete, ensureChecklist, markChecklist } from "./checklist";
import { postAnnouncement } from "./announcements";
import { closeAllSessions, formatAttendance, getAttendance } from "./attendance";
import { config } from "../config";
import {
  assertFutureDate,
  assertTransition,
  canTransition,
  validateApplicationInput,
} from "./rules";
import { assertNoScheduleConflict } from "./schedule";

export type EventWithCategory = Event & { category: EventCategory; report: EventReport | null };

// ─────────────────────────── ID заявок ───────────────────────────

/// Генерирует следующий код MP-XXXX атомарно (защита от race conditions).
export async function nextEventCode(guildId: string): Promise<string> {
  return prisma.$transaction(async (tx) => {
    const last = await tx.event.findFirst({
      where: { guildId },
      orderBy: { id: "desc" },
      select: { code: true },
    });
    const nextNum = last ? Number(last.code.split("-")[1]) + 1 : 1;
    return `MP-${String(nextNum).padStart(4, "0")}`;
  });
}

// ─────────────────────────── Создание заявки ───────────────────────────

export interface ApplicationInput {
  title: string;
  categoryId: number;
  description: string;
  rules?: string;
  dateStr: string;
  timeStr: string;
  durationMinutes: number;
  participantsPlanned: number;
  location?: string;
  extraInfo?: string;
}

export async function createApplication(
  client: Client,
  guildId: string,
  author: User,
  input: ApplicationInput
): Promise<EventWithCategory> {
  const { parseDateTime } = await import("../lib/time");
  const scheduledAt = parseDateTime(input.dateStr, input.timeStr);
  const valid = validateApplicationInput({ ...input });

  const category = await prisma.eventCategory.findUnique({ where: { id: input.categoryId } });
  if (!category || !category.active || category.guildId !== guildId) {
    throw new UserError("Выбранная категория не существует. Выберите категорию заново.");
  }
  assertFutureDate(scheduledAt);
  // Защита расписания: окно не должно пересекаться с уже запланированными МП.
  await assertNoScheduleConflict(guildId, scheduledAt, Math.round(valid.durationMinutes));

  const code = await nextEventCode(guildId);
  const event = await prisma.$transaction(async (tx) => {
    const created = await tx.event.create({
      data: {
        code,
        guildId,
        title: valid.title,
        categoryId: input.categoryId,
        authorId: author.id,
        description: valid.description,
        rules: valid.rules,
        scheduledAt,
        durationMinutes: Math.round(valid.durationMinutes),
        participantsPlanned: Math.round(valid.participantsPlanned),
        location: valid.location,
        extraInfo: valid.extraInfo,
        status: STATUS.PENDING,
      },
      include: { category: true, report: true },
    });
    await tx.eventStatusHistory.create({
      data: { eventId: created.id, fromStatus: null, toStatus: STATUS.PENDING, actorId: author.id },
    });
    await tx.application.create({
      data: { eventId: created.id, attempt: 1, authorId: author.id, status: STATUS.PENDING },
    });
    return created;
  });

  // Публикация в канале проверки.
  try {
    const settings = await getSettings(guildId);
    const reviewChannel = await client.channels.fetch(requireChannel(settings, "reviewChannelId"));
    if (reviewChannel && reviewChannel.type === ChannelType.GuildText) {
      const message = await reviewChannel.send({
        embeds: [buildReviewEmbed(event)],
        components: buildReviewComponents(event),
      });
      await prisma.event.update({ where: { id: event.id }, data: { reviewMessageId: message.id } });
    }
  } catch (err) {
    logger.error(`Не удалось опубликовать заявку ${event.code} в канале проверки:`, err);
  }

  // Создаём приватный канал для заявки
  await createApplicationChannel(client, event, author);

  await writeAudit(client, {
    guildId,
    action: "EVENT_CREATED",
    actorId: author.id,
    actorTag: author.tag,
    targetType: "event",
    targetId: event.code,
    newValue: STATUS.PENDING,
  });

  return event;
}

// ─────────────────────────── Embeds ───────────────────────────

export function buildReviewEmbed(event: EventWithCategory): EmbedBuilder {
  const meta = STATUS_RU[event.status];
  const embed = statusEmbed(
    `${meta.emoji} Заявка ${event.code} — «${event.title}»`,
    undefined,
    event.status
  );
  embed.addFields(
    { name: "🎭 Категория", value: `${event.category.emoji} ${event.category.name}`, inline: true },
    { name: "👤 Автор", value: `<@${event.authorId}>`, inline: true },
    { name: "🎯 Организатор", value: event.organizerId ? `<@${event.organizerId}>` : "не назначен", inline: true },
    { name: "📅 Дата и время", value: `${formatDateTime(event.scheduledAt)} (${discordTimestamp(event.scheduledAt, "R")})`, inline: true },
    { name: "⏱️ Продолжительность", value: `${event.durationMinutes} мин`, inline: true },
    { name: "👥 Участников (план)", value: String(event.participantsPlanned), inline: true },
    { name: "📍 Место", value: event.location ?? "не указано", inline: true },
    { name: "📖 Описание", value: event.description.slice(0, 1000) || "—" },
  );
  if (event.rules) embed.addFields({ name: "📏 Правила", value: event.rules.slice(0, 1000) });
  if (event.extraInfo) embed.addFields({ name: "ℹ️ Дополнительно", value: event.extraInfo.slice(0, 1000) });
  if (event.status === STATUS.REJECTED && event.rejectReason) {
    embed.addFields({ name: "❌ Причина отклонения", value: event.rejectReason.slice(0, 1000) });
  }
  if (event.status === STATUS.REVISION && event.revisionReason) {
    embed.addFields({ name: "✏️ Причина доработки", value: event.revisionReason.slice(0, 1000) });
  }
  return withFooter(embed);
}

export function buildReviewComponents(event: Event): ActionRowBuilder<ButtonBuilder>[] {
  const manageable = [STATUS.PENDING, STATUS.REVISION].includes(event.status as never);
  if (!manageable) return [];
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`mp:approve:${event.id}`).setLabel("Одобрить").setEmoji("☑").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`mp:revision:${event.id}`).setLabel("На доработку").setEmoji("✏️").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`mp:reject:${event.id}`).setLabel("Отклонить").setEmoji("❌").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`mp:assign:${event.id}`).setLabel("Назначить организатора").setEmoji("👤").setStyle(ButtonStyle.Primary)
    ),
  ];
}

export function buildEventEmbed(event: EventWithCategory): EmbedBuilder {
  const meta = STATUS_RU[event.status];
  const embed = statusEmbed(`🎯 МП «${event.title}»`, undefined, event.status);
  embed.addFields(
    { name: "🆔 Код", value: event.code, inline: true },
    { name: "🎭 Категория", value: `${event.category.emoji} ${event.category.name}`, inline: true },
    { name: "📊 Статус", value: `${meta.emoji} ${meta.label}`, inline: true },
    { name: "📅 Дата", value: formatShortDate(event.scheduledAt), inline: true },
    { name: "⏰ Время", value: formatTime(event.scheduledAt), inline: true },
    { name: "⏱️ Продолжительность", value: `${event.durationMinutes} мин`, inline: true },
    { name: "👤 Организатор", value: event.organizerId ? `<@${event.organizerId}>` : `<@${event.authorId}>`, inline: true },
    { name: "👥 Участников (план)", value: String(event.participantsPlanned), inline: true },
    { name: "📍 Место", value: event.location ?? "не указано", inline: true },
    { name: "📖 Описание", value: event.description.slice(0, 1000) || "—" },
  );
  if (event.rules) embed.addFields({ name: "📏 Правила", value: event.rules.slice(0, 1000) });
  return withFooter(embed);
}

export function buildEventComponents(event: Event): ActionRowBuilder<ButtonBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  const s = event.status;
  const visible = [STATUS.APPROVED, STATUS.PLANNED, STATUS.ACTIVE, STATUS.COMPLETED, STATUS.REPORTED].includes(s as never);
  if (!visible) return rows;

  rows.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`ev:scenario:${event.id}`).setLabel("Сценарий").setEmoji("📋").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`ev:team:${event.id}`).setLabel("Команда").setEmoji("👥").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`ev:announce:${event.id}`).setLabel("Объявление").setEmoji("📢").setStyle(ButtonStyle.Secondary)
    )
  );

  const startable = s === STATUS.PLANNED || s === STATUS.APPROVED;
  const finished = s === STATUS.ACTIVE;
  const reportable = s === STATUS.COMPLETED;
  rows.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`ev:start:${event.id}`).setLabel("Начать МП").setEmoji("▶️").setStyle(ButtonStyle.Success).setDisabled(!startable),
      new ButtonBuilder().setCustomId(`ev:finish:${event.id}`).setLabel("Завершить МП").setEmoji("🏁").setStyle(ButtonStyle.Danger).setDisabled(!finished),
      new ButtonBuilder().setCustomId(`ev:report:${event.id}`).setLabel("Создать отчёт").setEmoji("📋").setStyle(ButtonStyle.Primary).setDisabled(!reportable)
    )
  );

  // Подготовка и участие: чек-лист, записи «Буду» + голосовая посещаемость,
  // прикреплённые материалы, оценки участников.
  const utility = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`ev:checklist:${event.id}`).setLabel("Чек-лист").setEmoji("✅").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`ev:people:${event.id}`).setLabel("Участники").setEmoji("👥").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`ev:materials:${event.id}`).setLabel("Материалы").setEmoji("📚").setStyle(ButtonStyle.Secondary)
  );
  if (s === STATUS.COMPLETED || s === STATUS.REPORTED) {
    utility.addComponents(
      new ButtonBuilder().setCustomId(`ev:feedback:${event.id}`).setLabel("Оценки").setEmoji("⭐").setStyle(ButtonStyle.Secondary)
    );
  }
  rows.push(utility);

  if (s === STATUS.REPORTED) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`ev:archive:${event.id}`).setLabel("Архив").setEmoji("🗃️").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`ev:history:${event.id}`).setLabel("История").setEmoji("🕒").setStyle(ButtonStyle.Secondary)
      )
    );
  }
  return rows;
}

// ─────────────────────────── Переходы статусов ───────────────────────────

export async function loadEvent(id: number): Promise<EventWithCategory> {
  const event = await prisma.event.findUnique({ where: { id }, include: { category: true, report: true } });
  if (!event) throw new UserError("Мероприятие не найдено в БД (возможно, удалено).");
  return event;
}

/// Поиск мероприятия по коду MP-XXXX или числовому ID.
export async function findEvent(guildId: string, ref: string): Promise<EventWithCategory> {
  const trimmed = ref.trim();
  if (/^\d+$/.test(trimmed)) {
    const byId = await prisma.event.findUnique({ where: { id: Number(trimmed) }, include: { category: true, report: true } });
    if (byId && byId.guildId === guildId) return byId;
  }
  const byCode = await prisma.event.findFirst({
    where: { guildId, code: trimmed.toUpperCase() },
    include: { category: true, report: true },
  });
  if (!byCode) throw new UserError(`Мероприятие «${ref}» не найдено. Укажите код заявки, например MP-0001.`);
  return byCode;
}

export type EventWithMeta = Event & { category: EventCategory; report: EventReport | null };

export interface TransitionOptions {
  /// Текущие статусы, из которых разрешён переход (защита от гонок и повторов).
  expectedFrom?: readonly string[];
  actorId?: Snowflake | null;
  actorTag?: string | null;
  reason?: string | null;
  /// Дополнительные поля события, обновляемые вместе со статусом.
  data?: Record<string, unknown>;
  /// Действие аудита; по умолчанию выводится из целевого статуса.
  action?: string;
}

const AUDIT_BY_STATUS: Record<string, string> = {
  [STATUS.REPORTED]: "EVENT_REPORTED",
  [STATUS.ARCHIVED]: "EVENT_ARCHIVED",
  [STATUS.ACTIVE]: "EVENT_STARTED",
  [STATUS.COMPLETED]: "EVENT_FINISHED",
  [STATUS.REJECTED]: "EVENT_REJECTED",
  [STATUS.CANCELLED]: "EVENT_CANCELLED",
  [STATUS.REVISION]: "EVENT_REVISION",
  [STATUS.APPROVED]: "EVENT_APPROVED",
  [STATUS.PLANNED]: "EVENT_PLANNED",
  [STATUS.PENDING]: "EVENT_RESUBMITTED",
};

/// Атомарный переход статуса.
/// 1) проверяет допустимость перехода (canTransition);
/// 2) выполняет условный UPDATE (только если статус всё ещё ожидаемый) —
///    повторное нажатие кнопки/двойной клик завершаются понятной ошибкой;
/// 3) пишет EventStatusHistory и AuditLog.
export async function applyTransition(
  client: Client | null,
  event: Event,
  toStatus: string,
  options: TransitionOptions = {}
): Promise<Event> {
  const expected = options.expectedFrom ?? [event.status];

  return prisma.$transaction(async (tx) => {
    const current = await tx.event.findUnique({ where: { id: event.id } });
    if (!current) throw new UserError("Мероприятие не найдено в БД (возможно, удалено).");

    if (!expected.includes(current.status)) {
      throw new UserError(
        `Действие уже выполнено: статус изменился на «${STATUS_RU[current.status]?.label ?? current.status}».`
      );
    }
    assertTransition(current.status, toStatus);

    const res = await tx.event.updateMany({
      where: { id: event.id, status: current.status },
      data: { status: toStatus, ...(options.data ?? {}) },
    });
    if (res.count === 0) {
      throw new UserError("Действие уже выполнено другим участником. Обновите карточку.");
    }

    const updated = await tx.event.findUnique({ where: { id: event.id } });
    if (!updated) throw new UserError("Мероприятие исчезло во время обновления.");

    await tx.eventStatusHistory.create({
      data: {
        eventId: event.id,
        fromStatus: current.status,
        toStatus,
        actorId: options.actorId ?? null,
        reason: options.reason ?? null,
      },
    });

    if (client) {
      await writeAudit(client, {
        guildId: event.guildId,
        action: options.action ?? AUDIT_BY_STATUS[toStatus] ?? "EVENT_UPDATED",
        actorId: options.actorId ?? null,
        actorTag: options.actorTag ?? null,
        targetType: "event",
        targetId: event.code,
        oldValue: STATUS_RU[current.status]?.label ?? current.status,
        newValue: STATUS_RU[toStatus]?.label ?? toStatus,
        reason: options.reason ?? null,
      });
    }

    return updated;
  });
}

export { canTransition };

async function updateReviewMessage(client: Client, event: EventWithCategory): Promise<void> {
  if (!event.reviewMessageId) return;
  try {
    const settings = await getSettings(event.guildId);
    const channel = await client.channels.fetch(requireChannel(settings, "reviewChannelId"));
    if (channel?.type !== ChannelType.GuildText) return;
    const message = await channel.messages.fetch(event.reviewMessageId).catch(() => null);
    if (!message) return;
    await message.edit({
      embeds: [buildReviewEmbed(event)],
      components: buildReviewComponents(event),
    });
  } catch (err) {
    logger.warn(`Не удалось обновить сообщение проверки ${event.code}:`, err);
  }
}

async function updateEventMessage(client: Client, event: EventWithCategory): Promise<void> {
  if (!event.eventChannelId || !event.eventMessageId) return;
  try {
    const channel = await client.channels.fetch(event.eventChannelId).catch(() => null);
    if (channel?.type !== ChannelType.GuildText) return;
    const message = await channel.messages.fetch(event.eventMessageId).catch(() => null);
    if (!message) return;
    await message.edit({
      embeds: [buildEventEmbed(event)],
      components: buildEventComponents(event),
    });
  } catch (err) {
    logger.warn(`Не удалось обновить сообщение МП ${event.code}:`, err);
  }
}

export async function refreshEventViews(client: Client, event: EventWithCategory): Promise<void> {
  await Promise.all([updateReviewMessage(client, event), updateEventMessage(client, event)]);
  await Promise.all([updatePlanningBoard(client, event.guildId), updateActiveBoard(client, event.guildId)]);
}

// ─────────────────────────── Действия проверки ───────────────────────────

/// Обновляет последнюю запись заявки (согласование).
async function settleApplication(
  eventId: number,
  status: string,
  reviewerId?: string,
  comment?: string | null,
  nextAttempt = false
): Promise<void> {
  const latest = await prisma.application.findFirst({
    where: { eventId },
    orderBy: { attempt: "desc" },
  });
  if (!latest) return;
  if (nextAttempt) {
    await prisma.application.create({
      data: { eventId, attempt: latest.attempt + 1, authorId: latest.authorId, status: STATUS.PENDING },
    });
    return;
  }
  await prisma.application.update({
    where: { id: latest.id },
    data: { status, reviewerId: reviewerId ?? null, reviewComment: comment ?? null },
  });
}

/// Одобрение заявки: PENDING/REVISION → APPROVED (фиксируется проверяющий),
/// затем автопланирование APPROVED → PLANNED (создаются каналы мероприятия).
export async function approveEvent(client: Client, event: EventWithCategory, actor: User): Promise<EventWithCategory> {
  const approved = (await applyTransition(client, event, STATUS.APPROVED, {
    expectedFrom: [STATUS.PENDING, STATUS.REVISION],
    actorId: actor.id,
    actorTag: actor.tag,
    data: {
      approvedById: actor.id,
      approvedAt: new Date(),
      // Организатор по умолчанию — автор заявки, если руководство не назначило другого.
      organizerId: event.organizerId ?? event.authorId,
      rejectReason: null,
      revisionReason: null,
    },
  })) as EventWithCategory;

  await settleApplication(event.id, STATUS.APPROVED, actor.id, null);

  const planned = (await applyTransition(client, approved, STATUS.PLANNED, {
    expectedFrom: [STATUS.APPROVED],
    actorId: actor.id,
    actorTag: actor.tag,
  })) as EventWithCategory;

  await prisma.eventStaff.upsert({
    where: { eventId_userId: { eventId: event.id, userId: event.organizerId ?? event.authorId } },
    create: { eventId: event.id, userId: event.organizerId ?? event.authorId, role: "ORGANIZER" },
    update: { role: "ORGANIZER" },
  });

  await notifyUser(client, event.authorId,
    statusEmbed(`✅ Заявка ${event.code} одобрена`, `Ваше мероприятие «${event.title}» одобрено и запланировано на ${formatDateTime(event.scheduledAt)}.`, STATUS.APPROVED));

  // Уведомляем в приватный канал заявки
  await notifyApplicationStatus(client, event, STATUS.APPROVED, actor);

  // Чек-лист подготовки создаётся при планировании (auto-пункты закроет бот).
  await ensureChecklist(planned.id);

  const created = await ensureEventChannel(client, planned);

  // Анонс-мост: приглашение в тестовый канал организаторов (или webhook
  // официального сервера). Успешная публикация закрывает пункт «Анонс опубликован».
  if (await postAnnouncement(client, created, "SCHEDULED")) {
    await markChecklist(created.id, "ANNOUNCE", true);
  }

  await refreshEventViews(client, created);
  return created;
}

export async function rejectEvent(client: Client, event: EventWithCategory, actor: User, reason: string): Promise<EventWithCategory> {
  const updated = (await applyTransition(client, event, STATUS.REJECTED, {
    expectedFrom: [STATUS.PENDING, STATUS.REVISION],
    actorId: actor.id,
    actorTag: actor.tag,
    reason,
    data: {
      rejectedById: actor.id,
      rejectedAt: new Date(),
      rejectReason: reason,
    },
  })) as EventWithCategory;

  await settleApplication(event.id, STATUS.REJECTED, actor.id, reason);

  await notifyUser(client, event.authorId,
    statusEmbed(`❌ Заявка ${event.code} отклонена`, `Мероприятие «${event.title}» отклонено.\n**Причина:** ${reason}`, STATUS.REJECTED));

  // Уведомляем в приватный канал заявки
  await notifyApplicationStatus(client, event, STATUS.REJECTED, actor, reason);

  await refreshEventViews(client, updated);
  return updated;
}

export async function requestRevision(client: Client, event: EventWithCategory, actor: User, reason: string): Promise<EventWithCategory> {
  const updated = (await applyTransition(client, event, STATUS.REVISION, {
    expectedFrom: [STATUS.PENDING],
    actorId: actor.id,
    actorTag: actor.tag,
    reason,
    data: { revisionReason: reason },
  })) as EventWithCategory;

  await settleApplication(event.id, STATUS.REVISION, actor.id, reason);

  await notifyUser(client, event.authorId,
    statusEmbed(`✏️ Заявка ${event.code} отправлена на доработку`, `Мероприятие «${event.title}» требует доработки.\n**Причина:** ${reason}\n\nПосле исправлений отправйте заявку повторно в канале проверки.`, STATUS.REVISION));

  // Уведомляем в приватный канал заявки
  await notifyApplicationStatus(client, event, STATUS.REVISION, actor, reason);

  await refreshEventViews(client, updated);
  return updated;
}

export async function assignOrganizer(client: Client, event: EventWithCategory, actor: User, organizerId: string): Promise<EventWithCategory> {
  const oldOrganizer = event.organizerId;
  const updated = await prisma.event.update({
    where: { id: event.id },
    data: { organizerId },
    include: { category: true, report: true },
  });
  await prisma.eventStaff.upsert({
    where: { eventId_userId: { eventId: event.id, userId: organizerId } },
    create: { eventId: event.id, userId: organizerId, role: "ORGANIZER" },
    update: { role: "ORGANIZER" },
  });
  await notifyUser(client, organizerId,
    statusEmbed(`👤 Вы назначены организатором МП ${event.code}`, `Мероприятие «${event.title}» — ${formatDateTime(event.scheduledAt)}.`, STATUS.PLANNED));
  await writeAudit(client, {
    guildId: event.guildId,
    action: "ORGANIZER_ASSIGNED",
    actorId: actor.id,
    actorTag: actor.tag,
    targetType: "event",
    targetId: event.code,
    oldValue: oldOrganizer ? `<@${oldOrganizer}>` : null,
    newValue: `<@${organizerId}>`,
  });
  await refreshEventViews(client, updated);
  return updated;
}

export async function resubmitEvent(client: Client, event: EventWithCategory, author: User): Promise<void> {
  const updated = await applyTransition(client, event, STATUS.PENDING, {
    expectedFrom: [STATUS.REVISION],
    actorId: author.id,
    actorTag: author.tag,
    data: { revisionReason: null },
  });
  await settleApplication(event.id, STATUS.PENDING, undefined, null, true);

  // Публикуем заново в канале проверки.
  try {
    const settings = await getSettings(event.guildId);
    const reviewChannel = await client.channels.fetch(requireChannel(settings, "reviewChannelId"));
    if (reviewChannel?.type === ChannelType.GuildText) {
      const fresh = await loadEvent(event.id);
      const message = await reviewChannel.send({
        embeds: [buildReviewEmbed(fresh)],
        components: buildReviewComponents(fresh),
      });
      await prisma.event.update({ where: { id: event.id }, data: { reviewMessageId: message.id } });
      await refreshEventViews(client, fresh);
    }
  } catch (err) {
    logger.error(`Не удалось перепубликовать заявку ${event.code}:`, err);
  }
  void updated;
}

// ─────────────────────────── Каналы мероприятий ───────────────────────────

function eventChannelName(title: string, date: Date): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-zа-яё0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  return `🎯・мп-${slug || "мероприятие"}-${dd}${mm}`;
}

/// Гильдия, в которой живут каналы мероприятия: официальный сервер (если
/// задан в OFFICIAL_GUILD_ID и бот туда приглашён), иначе сервер организаторов.
async function resolveEventGuild(client: Client, event: Event): Promise<import("discord.js").Guild> {
  if (config.officialGuildId && config.officialGuildId !== event.guildId) {
    const official = await client.guilds.fetch(config.officialGuildId).catch(() => null);
    if (official) return official;
  }
  return client.guilds.fetch(event.guildId);
}

const OFFICIAL_CATEGORY_NAME = "🎯・Мероприятия";

/// Категория для каналов МП на официальном сервере (идемпотентно).
async function ensureOfficialCategory(guild: import("discord.js").Guild): Promise<string | null> {
  const existing = guild.channels.cache.find(
    (c) => c.name === OFFICIAL_CATEGORY_NAME && c.type === ChannelType.GuildCategory
  );
  if (existing) return existing.id;
  try {
    const created = await guild.channels.create({
      name: OFFICIAL_CATEGORY_NAME,
      type: ChannelType.GuildCategory,
      reason: "Категория для мероприятий (официальный сервер)",
    });
    return created.id;
  } catch (err) {
    logger.warn(`Не удалось создать категорию «${OFFICIAL_CATEGORY_NAME}» на ${guild.name}:`, err);
    return null;
  }
}

/// Создаёт текстовый канал МП с embed и кнопками. Идемпотентно:
/// повторный вызов не создаёт дубликатов, восстанавливает voice при необходимости.
export async function ensureEventChannel(client: Client, event: EventWithCategory): Promise<EventWithCategory> {
  if (event.eventChannelId) {
    const existing = await client.channels.fetch(event.eventChannelId).catch(() => null);
    if (existing && existing.type === ChannelType.GuildText) {
      await markChecklist(event.id, "CHANNELS", true);
      if (!event.voiceChannelId) await ensureEventVoice(client, event);
      return event;
    }
    // Канал удалён вручную — сбрасываем привязку и создаём заново.
    event = { ...event, eventChannelId: null, eventMessageId: null };
    await prisma.event
      .update({ where: { id: event.id }, data: { eventChannelId: null, eventMessageId: null } })
      .catch(() => undefined);
  }

  const settings = await getSettings(event.guildId);
  const guild = await resolveEventGuild(client, event);
  const official = guild.id !== event.guildId;

  let parentId: string | undefined;
  let overwrites: import("discord.js").OverwriteData[] | undefined;

  if (official) {
    // Официальный сервер: права по умолчанию (роли отдела там не существуют).
    parentId = (await ensureOfficialCategory(guild)) ?? undefined;
  } else {
    const roles = resolveRoleSet(guild, settings);
    const anchor = await client.channels.fetch(requireChannel(settings, "planningChannelId")).catch(() => null);
    if (!anchor || anchor.type !== ChannelType.GuildText || !anchor.parentId) {
      logger.warn(`Не удалось определить категорию для канала МП ${event.code} — канал планирования без категории.`);
      return event;
    }
    parentId = anchor.parentId;
    overwrites = buildOverwrites(roles, "work", false, true);
  }

  const channel = await guild.channels.create({
    name: eventChannelName(event.title, event.scheduledAt),
    type: ChannelType.GuildText,
    parent: parentId,
    topic: `${event.code} — «${event.title}» — ${formatDateTime(event.scheduledAt)}`,
    reason: `Канал мероприятия ${event.code}`,
    ...(overwrites ? { permissionOverwrites: overwrites } : {}),
  });

  const message = await channel.send({
    content: `<@${event.organizerId ?? event.authorId}>`,
    embeds: [buildEventEmbed(event)],
    components: buildEventComponents(event),
  });

  const updated = await prisma.event.update({
    where: { id: event.id },
    data: { eventChannelId: channel.id, eventMessageId: message.id },
    include: { category: true, report: true },
  });

  await writeAudit(client, {
    guildId: event.guildId,
    action: "EVENT_CHANNEL_CREATED",
    targetType: "channel",
    targetId: channel.id,
    newValue: event.code,
  });

  await markChecklist(updated.id, "CHANNELS", true);
  await ensureEventVoice(client, updated);
  return updated;
}

/// Родительская категория для голосового канала мероприятия:
/// категория постоянного voice «Проведение МП», иначе категория планирования.
async function resolveVoiceParent(
  client: Client,
  settings: GuildSettings,
  fallbackParentId: string | null
): Promise<string | null> {
  if (settings.voiceEventsId) {
    const voiceChannel = await client.channels.fetch(settings.voiceEventsId).catch(() => null);
    if (voiceChannel && "parentId" in voiceChannel && voiceChannel.parentId) return voiceChannel.parentId;
  }
  if (settings.planningChannelId) {
    const planning = await client.channels.fetch(settings.planningChannelId).catch(() => null);
    if (planning && "parentId" in planning && planning.parentId) return planning.parentId;
  }
  return fallbackParentId;
}

/// Создаёт голосовой канал мероприятия (идемпотентно). Ранее parent брался
/// из ID голосового канала, что Discord отклоняет — теперь берётся категория.
export async function ensureEventVoice(client: Client, event: EventWithCategory): Promise<void> {
  try {
    if (event.voiceChannelId) {
      const existing = await client.channels.fetch(event.voiceChannelId).catch(() => null);
      if (existing && (existing.type === ChannelType.GuildVoice || existing.type === ChannelType.GuildStageVoice)) {
        await markChecklist(event.id, "VOICE", true);
        return;
      }
      await prisma.event.update({ where: { id: event.id }, data: { voiceChannelId: null } }).catch(() => undefined);
      event = { ...event, voiceChannelId: null };
    }

    const settings = await getSettings(event.guildId);
    const guild = await resolveEventGuild(client, event);
    const official = guild.id !== event.guildId;

    let parentId: string | null;
    let overwrites: import("discord.js").OverwriteData[] | undefined;
    if (official) {
      parentId = await ensureOfficialCategory(guild);
    } else {
      const roles = resolveRoleSet(guild, settings);
      parentId = await resolveVoiceParent(client, settings, null);
      overwrites = buildOverwrites(roles, "work", true, true);
    }
    if (!parentId) {
      logger.warn(`Нет категории для голосового канала ${event.code} — выполните /setup.`);
      return;
    }

    const voice = await guild.channels.create({
      name: `🎯 Проведение — ${event.code}`.slice(0, 100),
      type: ChannelType.GuildVoice,
      parent: parentId,
      reason: `Голосовой канал мероприятия ${event.code}`,
      ...(overwrites ? { permissionOverwrites: overwrites } : {}),
    });
    await prisma.event.update({ where: { id: event.id }, data: { voiceChannelId: voice.id } });
    event.voiceChannelId = voice.id;
    await markChecklist(event.id, "VOICE", true);
    await writeAudit(client, {
      guildId: event.guildId,
      action: "EVENT_VOICE_CREATED",
      targetType: "channel",
      targetId: voice.id,
      newValue: event.code,
    });
  } catch (err) {
    logger.warn(`Не удалось создать voice-канал для ${event.code}:`, err);
  }
}

// ─────────────────────────── Запуск / завершение / архив ───────────────────────────

/// Проверки перед запуском МП.
function assertStartable(event: EventWithCategory): void {
  if (event.status !== STATUS.APPROVED && event.status !== STATUS.PLANNED) {
    throw new UserError(
      `Запустить можно только запланированное МП (сейчас: ${STATUS_RU[event.status]?.label ?? event.status}).`
    );
  }
  if (!event.organizerId) {
    throw new UserError("Организатор не назначен. Сначала выполните /assign (или одобрите заявку).");
  }
}

export async function startEvent(client: Client, event: EventWithCategory, actor: User): Promise<EventWithCategory> {
  assertStartable(event);

  // Канал и голосовая должны существовать — создаём/восстанавливаем при необходимости.
  // Здесь же закрываются auto-пункты чек-листа (CHANNELS, VOICE).
  let prepared = await ensureEventChannel(client, event);

  // Запуск блокируется, пока чек-лист подготовки не закрыт полностью.
  await assertChecklistComplete(prepared.id);

  const updated = (await applyTransition(client, prepared, STATUS.ACTIVE, {
    expectedFrom: [STATUS.APPROVED, STATUS.PLANNED],
    actorId: actor.id,
    actorTag: actor.tag,
    data: { startedAt: new Date() },
    action: "EVENT_STARTED",
    reason: `Организатор: ${event.organizerId ?? event.authorId}`,
  })) as EventWithCategory;

  prepared = await loadEvent(event.id);
  await notifyUser(client, prepared.organizerId ?? prepared.authorId,
    statusEmbed(`▶️ МП «${prepared.title}» началось`, `Код: ${prepared.code}. Канал: ${prepared.eventChannelId ? `<#${prepared.eventChannelId}>` : "—"}.`, STATUS.ACTIVE));

  // Анонс-мост: «МП началось» в тестовый канал / webhook официального сервера.
  await postAnnouncement(client, prepared, "STARTED");

  await refreshEventViews(client, prepared);
  void updated;
  return prepared;
}

export async function finishEvent(client: Client, event: EventWithCategory, actor: User): Promise<EventWithCategory> {
  if (event.status !== STATUS.ACTIVE) {
    throw new UserError(`Завершить можно только идущее МП (сейчас: ${STATUS_RU[event.status]?.label ?? event.status}).`);
  }
  const settings = await getSettings(event.guildId);
  const reportDueAt = new Date(Date.now() + settings.reportDeadlineHours * 3600_000);

  const updated = (await applyTransition(client, event, STATUS.COMPLETED, {
    expectedFrom: [STATUS.ACTIVE],
    actorId: actor.id,
    actorTag: actor.tag,
    data: { finishedAt: new Date(), reportDueAt },
  })) as EventWithCategory;

  // Закрываем незавершённые голосовые сессии — минуты фиксируются в БД.
  await closeAllSessions(event.id);

  await notifyUser(client, event.organizerId ?? event.authorId,
    statusEmbed(`📋 Требуется отчёт по ${event.code}`, `Мероприятие «${event.title}» завершено. Создайте отчёт в канале МП до ${formatDateTime(reportDueAt)}.`, STATUS.COMPLETED));

  // Сводка фактической посещаемости (по голосовому каналу) в канале МП.
  const attendanceText = formatAttendance(await getAttendance(event.id));
  if (attendanceText && updated.eventChannelId) {
    const channel = await client.channels.fetch(updated.eventChannelId).catch(() => null);
    if (channel?.type === ChannelType.GuildText) {
      await channel.send({ embeds: [infoEmbed(`🎙 Посещаемость ${event.code}`, attendanceText)] }).catch(() => undefined);
    }
  }

  // Блокируем voice-канал: без Connect, удаляется планировщиком через voiceDeleteDelayMin.
  if (event.voiceChannelId) {
    try {
      // client.channels.fetch работает и для каналов на официальном сервере.
      const voice = await client.channels.fetch(event.voiceChannelId).catch(() => null);
      if (voice && (voice.type === ChannelType.GuildVoice || voice.type === ChannelType.GuildStageVoice)) {
        await voice.permissionOverwrites.edit(voice.guild.roles.everyone, { Connect: false });
      }
    } catch (err) {
      logger.warn(`Не удалось заблокировать voice-канал ${event.code}:`, err);
    }
  }

  await evaluateAchievements(client, event.guildId, event.organizerId ?? event.authorId);

  // Начисляем базовые очки рейтинга за завершение МП
  await awardEventPoints(client, updated, updated.category, null);
  await checkRatingBadges(client, event.guildId, event.organizerId ?? event.authorId);

  // Анонс-мост: «МП завершено» + кнопки оценки для участников.
  await postAnnouncement(client, updated, "FINISHED");

  await refreshEventViews(client, updated);
  return updated;
}

export type ActorRef = Pick<User, "id" | "tag">;

export async function cancelEvent(
  client: Client,
  event: EventWithCategory,
  actor: ActorRef,
  reason: string
): Promise<EventWithCategory> {
  const updated = (await applyTransition(client, event, STATUS.CANCELLED, {
    expectedFrom: [STATUS.DRAFT, STATUS.PENDING, STATUS.REVISION, STATUS.APPROVED, STATUS.PLANNED, STATUS.ACTIVE],
    actorId: actor.id,
    actorTag: actor.tag,
    reason,
    data: {
      cancelledById: actor.id,
      cancelledAt: new Date(),
      cancelReason: reason,
    },
  })) as EventWithCategory;

  await notifyUser(client, event.authorId,
    statusEmbed(`🚫 МП ${event.code} отменено`, `Мероприятие «${event.title}» отменено.\n**Причина:** ${reason}`, STATUS.CANCELLED));
  await closeAllSessions(event.id);
  await cleanupEventChannels(client, updated, true);
  // Обновляем анонс (или публикуем новый): участники увидят отмену.
  await postAnnouncement(client, updated, "CANCELLED");
  await refreshEventViews(client, updated);
  return updated;
}

/// Архивирование. Допустимо только после сдачи отчёта.
/// actor: null — автоматическое архивирование планировщиком.
export async function archiveEvent(
  client: Client,
  event: EventWithCategory,
  actor: ActorRef | null
): Promise<EventWithCategory> {
  if (!event.report) {
    const withReport = await loadEvent(event.id);
    if (!withReport.report) throw new UserError("Архивирование доступно только после сдачи отчёта.");
  }
  const updated = (await applyTransition(client, event, STATUS.ARCHIVED, {
    expectedFrom: [STATUS.REPORTED],
    actorId: actor?.id ?? null,
    actorTag: actor?.tag ?? null,
    reason: actor ? null : "Автоматическое архивирование по расписанию",
    data: { archivedAt: new Date() },
  })) as EventWithCategory;

  await cleanupEventChannels(client, updated, true);
  await refreshEventViews(client, updated);
  return updated;
}

/// Блокирует и (с задержкой) удаляет каналы мероприятия. Задержка задаётся
/// в настройках сервера (voiceDeleteDelayMin); саму задержку выполняет планировщик.
async function cleanupEventChannels(client: Client, event: EventWithCategory, deleteTextChannel: boolean): Promise<void> {
  try {
    if (event.voiceChannelId) {
      // client.channels.fetch работает для каналов любой гильдии бота.
      const voice = await client.channels.fetch(event.voiceChannelId).catch(() => null);
      if (voice && (voice.type === ChannelType.GuildVoice || voice.type === ChannelType.GuildStageVoice)) {
        await voice.permissionOverwrites.edit(voice.guild.roles.everyone, { Connect: false }).catch(() => null);
        // Немедленное удаление только при полном архивировании; для завершения — планировщик.
      }
    }
    if (deleteTextChannel && event.eventChannelId) {
      const channel = await client.channels.fetch(event.eventChannelId).catch(() => null);
      if (channel) await channel.delete(`Архивирование ${event.code}`).catch(() => null);
      await prisma.event.update({ where: { id: event.id }, data: { eventChannelId: null, eventMessageId: null } });
    }
  } catch (err) {
    logger.warn(`Не удалось очистить каналы мероприятия ${event.code}:`, err);
  }
}

// ─────────────────────────── Борд-панели ───────────────────────────

async function upsertBoard(client: Client, guildId: string, key: "PLANNING" | "ACTIVE" | "STATS", embed: EmbedBuilder): Promise<void> {
  const settings = await getSettings(guildId);
  const channelId =
    key === "PLANNING" ? settings.planningChannelId :
    key === "ACTIVE" ? settings.activeChannelId :
    settings.statsChannelId;
  if (!channelId) return;

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (channel?.type !== ChannelType.GuildText) return;

  const board = await prisma.boardMessage.findUnique({
    where: { guildId_key: { guildId, key } },
  });

  try {
    if (board) {
      const message = await channel.messages.fetch(board.messageId).catch(() => null);
      if (message) {
        await message.edit({ embeds: [embed] });
        return;
      }
      // Сообщение удалено вручную — создадим новое.
      await prisma.boardMessage.delete({ where: { id: board.id } }).catch(() => null);
    }
    const message = await channel.send({ embeds: [embed] });
    await prisma.boardMessage.create({
      data: { guildId, key, channelId, messageId: message.id },
    });
  } catch (err) {
    logger.warn(`Не удалось обновить борд ${key}:`, err);
  }
}

/// Панель планирования: реальные будущие мероприятия из БД.
export async function updatePlanningBoard(client: Client, guildId: string): Promise<void> {
  const events = await prisma.event.findMany({
    where: {
      guildId,
      status: { in: [STATUS.APPROVED, STATUS.PLANNED, STATUS.ACTIVE] },
      scheduledAt: { gte: new Date(Date.now() - 24 * 3600_000) },
    },
    orderBy: { scheduledAt: "asc" },
    include: { category: true, report: true },
    take: 25,
  });

  const embed = baseEmbed("📅 Планирование мероприятий")
    .setColor(COLORS.INFO)
    .setDescription(
      events.length === 0
        ? "Запланированных мероприятий пока нет. Подайте заявку в 📝・заявки-на-мп."
        : events
            .map((e) => {
              const meta = STATUS_RU[e.status];
              return `**${formatShortDate(e.scheduledAt)}** — **${e.title}** — ${formatTime(e.scheduledAt)} — ${meta.emoji} ${meta.label} — \`${e.code}\` — <@${e.organizerId ?? e.authorId}>`;
            })
            .join("\n")
    );
  embed.setFooter({ text: "Обновляется автоматически • Отдел организаторов МП Arizona" });
  await upsertBoard(client, guildId, "PLANNING", embed);
}

/// Панель активных МП.
export async function updateActiveBoard(client: Client, guildId: string): Promise<void> {
  const events = await prisma.event.findMany({
    where: { guildId, status: STATUS.ACTIVE },
    orderBy: { startedAt: "asc" },
    include: { category: true, report: true },
  });

  const embed = baseEmbed("🎯 Активные мероприятия")
    .setColor(COLORS.SUCCESS)
    .setDescription(
      events.length === 0
        ? "Сейчас не проводится ни одного мероприятия."
        : events
            .map(
              (e) =>
                `**${e.title}** \`${e.code}\` — организатор <@${e.organizerId ?? e.authorId}> — начато ${discordTimestamp(e.startedAt ?? e.scheduledAt, "R")}${e.eventChannelId ? ` — <#${e.eventChannelId}>` : ""}`
            )
            .join("\n")
    );
  embed.setFooter({ text: "Обновляется автоматически • Отдел организаторов МП Arizona" });
  await upsertBoard(client, guildId, "ACTIVE", embed);
}

/// Панель статистики (обновляется по кнопке «Обновить» и планировщиком).
export async function updateStatsBoard(client: Client, guildId: string, guildName: string): Promise<void> {
  const embed = await statsBoardEmbed(guildId, guildName);
  await upsertBoard(client, guildId, "STATS", embed);
}

/// Автозапуск APPROVED/PLANNED мероприятий, у которых наступило время.
export async function autoStartDueEvents(client: Client, guildId: string): Promise<number> {
  const due = await prisma.event.findMany({
    where: {
      guildId,
      status: { in: [STATUS.APPROVED, STATUS.PLANNED] },
      scheduledAt: { lte: new Date() },
    },
  });
  let started = 0;
  for (const event of due) {
    try {
      const fresh = await loadEvent(event.id);
      const updated = (await applyTransition(client, fresh, STATUS.ACTIVE, {
        expectedFrom: [STATUS.APPROVED, STATUS.PLANNED],
        actorId: null,
        action: "EVENT_STARTED",
        reason: "Автозапуск по расписанию",
        data: { startedAt: new Date() },
      })) as EventWithCategory;
      started++;
      await notifyUser(client, updated.organizerId ?? updated.authorId,
        statusEmbed(`▶️ МП «${updated.title}» началось (автозапуск)`, `Код: ${updated.code}. Время мероприятия наступило.`, STATUS.ACTIVE));
      await postAnnouncement(client, updated, "STARTED");
      await refreshEventViews(client, updated);
    } catch (err) {
      // Повторный проход или конкурентный запуск — не ошибка планировщика.
      if (err instanceof UserError) logger.debug(`Автозапуск ${event.code}: ${err.message}`);
      else logger.error(`Автозапуск ${event.code} не удался:`, err);
    }
  }
  return started;
}

// ─────────────────────────── Задачи планировщика ───────────────────────────

/// Уведомление о приближающемся МП. Повторно не отправляется
/// (upcomingNotifiedAt хранится в БД — переживает рестарт).
export async function notifyUpcomingEvents(client: Client, guildId: string, minutesAhead: number): Promise<number> {
  const now = new Date();
  const horizon = new Date(now.getTime() + minutesAhead * 60_000);
  const upcoming = await prisma.event.findMany({
    where: {
      guildId,
      status: { in: [STATUS.APPROVED, STATUS.PLANNED] },
      scheduledAt: { gte: now, lte: horizon },
      upcomingNotifiedAt: null,
    },
  });

  for (const event of upcoming) {
    try {
      const fresh = await loadEvent(event.id);
      const targets = new Set<string>([fresh.authorId, fresh.organizerId ?? ""]);
      for (const s of await prisma.eventStaff.findMany({ where: { eventId: fresh.id } })) targets.add(s.userId);
      targets.delete("");

      for (const userId of targets) {
        await notifyUser(client, userId, statusEmbed(
          `⏰ МП скоро: «${fresh.title}»`,
          `Код: ${fresh.code}\nНачало: ${formatDateTime(fresh.scheduledAt)} (${discordTimestamp(fresh.scheduledAt, "R")})` +
            `${fresh.eventChannelId ? `\nКанал: <#${fresh.eventChannelId}>` : ""}`,
          STATUS.PLANNED
        ));
      }

      if (fresh.eventChannelId) {
        const channel = await client.channels.fetch(fresh.eventChannelId).catch(() => null);
        if (channel?.type === ChannelType.GuildText) {
          await channel.send({
            content: `<@${fresh.organizerId ?? fresh.authorId}>`,
            embeds: [statusEmbed(`⏰ МП начинается ${formatDateTime(fresh.scheduledAt)}`, `Не забудьте подготовиться. Код: ${fresh.code}`, STATUS.PLANNED)],
          }).catch(() => undefined);
        }
      }

      await prisma.event.update({ where: { id: fresh.id }, data: { upcomingNotifiedAt: new Date() } });
      await writeAudit(client, {
        guildId,
        action: "EVENT_REMINDER_SENT",
        targetType: "event",
        targetId: fresh.code,
        newValue: `Напоминание за ${minutesAhead} мин`,
      });
    } catch (err) {
      logger.warn(`Не удалось отправить напоминание по ${event.code}:`, err);
    }
  }
  return upcoming.length;
}

/// Напоминания о просроченных отчётах (не больше maxReminders раз).
export async function remindOverdueReports(client: Client, guildId: string, maxReminders = 3): Promise<number> {
  const overdue = await prisma.event.findMany({
    where: {
      guildId,
      status: STATUS.COMPLETED,
      reportDueAt: { lt: new Date() },
      reportReminderCount: { lt: maxReminders },
    },
  });

  for (const event of overdue) {
    try {
      const fresh = await loadEvent(event.id);
      const target = fresh.organizerId ?? fresh.authorId;
      await notifyUser(client, target, statusEmbed(
        `⚠️ Просрочен отчёт по ${fresh.code}`,
        `Мероприятие «${fresh.title}» завершено, но отчёт не сдан.\nСрок истёк: ${formatDateTime(fresh.reportDueAt ?? fresh.finishedAt ?? fresh.scheduledAt)}.`,
        STATUS.COMPLETED
      ));
      if (fresh.eventChannelId) {
        const channel = await client.channels.fetch(fresh.eventChannelId).catch(() => null);
        if (channel?.type === ChannelType.GuildText) {
          await channel.send({ content: `<@${target}>`, embeds: [statusEmbed("⚠️ Требуется отчёт", `Код: ${fresh.code} — отчёт просрочен.`, STATUS.COMPLETED)] })
            .catch(() => undefined);
        }
      }
      await prisma.event.update({
        where: { id: fresh.id },
        data: { reportReminderCount: { increment: 1 } },
      });
    } catch (err) {
      logger.warn(`Не удалось напомнить об отчёте по ${event.code}:`, err);
    }
  }
  return overdue.length;
}

/// Автоархив: REPORTED дольше archiveAfterDays → ARCHIVED (данные сохраняются).
export async function autoArchiveReported(client: Client, guildId: string, afterDays: number): Promise<number> {
  const cutoff = new Date(Date.now() - afterDays * 24 * 3600_000);
  const due = await prisma.event.findMany({
    where: { guildId, status: STATUS.REPORTED, reportedAt: { lte: cutoff } },
  });
  let archived = 0;
  for (const event of due) {
    try {
      const fresh = await loadEvent(event.id);
      await archiveEvent(client, fresh, null);
      archived++;
    } catch (err) {
      if (err instanceof UserError) logger.debug(`Автоархив ${event.code}: ${err.message}`);
      else logger.warn(`Автоархив ${event.code} не удался:`, err);
    }
  }
  return archived;
}

/// Удаление завершённых голосовых каналов через настроенную задержку.
export async function cleanupExpiredVoiceChannels(client: Client, guildId: string, delayMinutes: number): Promise<number> {
  const cutoff = new Date(Date.now() - delayMinutes * 60_000);
  const finishedStates = await prisma.event.findMany({
    where: {
      guildId,
      voiceChannelId: { not: null },
      status: { in: [STATUS.COMPLETED, STATUS.REPORTED, STATUS.ARCHIVED, STATUS.CANCELLED] },
      OR: [{ finishedAt: { lte: cutoff } }, { cancelledAt: { lte: cutoff } }, { archivedAt: { lte: cutoff } }],
    },
  });

  let removed = 0;
  for (const event of finishedStates) {
    try {
      const voice = await client.channels.fetch(event.voiceChannelId!).catch(() => null);
      if (voice && (voice.type === ChannelType.GuildVoice || voice.type === ChannelType.GuildStageVoice)) {
        await voice.delete(`Голосовой канал завершённого МП ${event.code}`).catch(() => undefined);
      }
      await prisma.event.update({ where: { id: event.id }, data: { voiceChannelId: null } });
      await writeAudit(client, {
        guildId,
        action: "EVENT_VOICE_DELETED",
        targetType: "channel",
        targetId: event.voiceChannelId ?? "",
        newValue: event.code,
      });
      removed++;
    } catch (err) {
      logger.warn(`Не удалось удалить voice-канал ${event.code}:`, err);
    }
  }
  return removed;
}

/// Восстановление после рестарта: для текущих МП проверяет существование
/// каналов и пересоздаёт недостающие (идемпотентно).
export async function restoreEventChannels(client: Client, guildId: string): Promise<number> {
  const running = await prisma.event.findMany({
    where: { guildId, status: { in: [STATUS.APPROVED, STATUS.PLANNED, STATUS.ACTIVE, STATUS.COMPLETED, STATUS.REPORTED] } },
    include: { category: true, report: true },
    orderBy: { scheduledAt: "desc" },
    take: 50,
  });
  let restored = 0;
  for (const event of running) {
    try {
      const needsChannel = !event.eventChannelId || !(await channelExists(client, event.eventChannelId));
      const needsVoice = !event.voiceChannelId || !(await channelExists(client, event.voiceChannelId));
      if (needsChannel) await ensureEventChannel(client, event);
      else if (needsVoice) await ensureEventVoice(client, event);
      if (needsChannel || needsVoice) restored++;
    } catch (err) {
      logger.warn(`Восстановление каналов ${event.code} не удалось:`, err);
    }
  }
  return restored;
}

async function channelExists(client: Client, channelId: string): Promise<boolean> {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  return Boolean(channel);
}

export { evaluateAchievements };
