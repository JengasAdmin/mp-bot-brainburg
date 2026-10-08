import {
  ChannelType,
  type Client,
  type Guild,
  type GuildMember,
  type User,
} from "discord.js";
import { prisma } from "../lib/db";
import { UserError } from "../lib/errors";
import { successEmbed, warnEmbed, baseEmbed, COLORS } from "../lib/embeds";
import { POSITION_RANK, POSITION_RU, type Position } from "../permissions/matrix";
import { writeAudit } from "./audit";
import { notifyUser } from "./notifications";
import { getSettings } from "./settings";
import { formatDateTime } from "../lib/time";
import { logger } from "../lib/logger";

const STAFF_ROLES: Partial<Record<Position, string>> = {
  ADMIN: "roleMainAdminId",
  CURATOR: "roleCuratorId",
  HEAD: "roleHeadOrganizerId",
  SENIOR: "roleSeniorOrganizerId",
  ORGANIZER: "roleOrganizerId",
  ASSISTANT: "roleAssistantId",
};

/// Повышение/понижение: меняет Discord-роли (источник истины) + фиксирует в БД.
export async function setPosition(
  client: Client,
  guild: Guild,
  target: GuildMember,
  newPosition: Position,
  actor: User,
  reason: string
): Promise<void> {
  const settings = await getSettings(guild.id);
  const oldPosition = await prisma.user.findUnique({ where: { discordId: target.id } })
    .then((u) => (u?.position as Position) ?? "GUEST");

  if (POSITION_RANK[newPosition] === 0) {
    throw new UserError("Эта роль не назначается через кадровую систему.");
  }
  if (oldPosition === newPosition) {
    throw new UserError(`У ${target.displayName} уже есть должность «${POSITION_RU[newPosition]}».`);
  }

  const me = guild.members.me;
  if (!me || !me.permissions.has("ManageRoles")) {
    throw new UserError("У бота нет права «Управление ролями». Выдайте его и повторите.");
  }

  const roleId = STAFF_ROLES[newPosition];
  if (!roleId || !settings[roleId as keyof typeof settings]) {
    throw new UserError("Роль для этой должности не настроена. Выполните /setup.");
  }
  const targetRole = guild.roles.cache.get(settings[roleId as keyof typeof settings] as string);
  if (!targetRole) throw new UserError("Роль должности удалена с сервера. Выполните /setup повторно.");
  if (targetRole.position >= me.roles.highest.position) {
    throw new UserError("Роль должности выше роли бота — бот не сможет её выдать. Переместите роль бота в иерархии.");
  }

  // Снимаем прочие должностные роли, выдаём целевую.
  const staffRoleIds = Object.values(STAFF_ROLES)
    .map((k) => settings[k as keyof typeof settings] as string | null)
    .filter((id): id is string => Boolean(id));
  for (const id of staffRoleIds) {
    if (id !== targetRole.id && target.roles.cache.has(id)) {
      await target.roles.remove(id, reason).catch((err) => logger.warn("roles.remove:", err));
    }
  }
  await target.roles.add(targetRole, reason);

  await prisma.user.upsert({
    where: { discordId: target.id },
    create: { discordId: target.id, username: target.user.username, nickname: target.displayName, position: newPosition },
    update: { position: newPosition },
  });

  await writeAudit(client, {
    guildId: guild.id,
    action: "POSITION_CHANGED",
    actorId: actor.id,
    actorTag: actor.tag,
    targetType: "member",
    targetId: target.id,
    oldValue: POSITION_RU[oldPosition],
    newValue: POSITION_RU[newPosition],
    reason,
  });

  // Публикация в канале повышений.
  try {
    if (settings.promotionsChannelId) {
      const channel = await client.channels.fetch(settings.promotionsChannelId).catch(() => null);
      if (channel?.type === ChannelType.GuildText) {
        const isPromotion = POSITION_RANK[newPosition] > POSITION_RANK[oldPosition];
        await channel.send({
          embeds: [
            successEmbed(
              isPromotion ? "⭐ Повышение" : "📉 Изменение должности",
              `<@${target.id}> — **${POSITION_RU[oldPosition]}** → **${POSITION_RU[newPosition]}**\n\nПричина: ${reason}\nРешение принял: <@${actor.id}> (${formatDateTime(new Date())})`
            ),
          ],
        });
      }
    }
  } catch (err) {
    logger.warn("Не удалось опубликовать кадровое решение:", err);
  }

  await notifyUser(client, target.id,
    successEmbed(isPromotionTitle(oldPosition, newPosition), `Ваша должность изменена: **${POSITION_RU[newPosition]}**.\nПричина: ${reason}`));
}

function isPromotionTitle(oldPos: Position, newPos: Position): string {
  return POSITION_RANK[newPos] > POSITION_RANK[oldPos] ? "⭐ Повышение" : "📉 Изменение должности";
}

// ─────────────────────────── Взыскания ───────────────────────────

export async function issueSanction(
  client: Client,
  guildId: string,
  targetId: string,
  type: "WARNING" | "REPRIMAND",
  reason: string,
  actor: User,
  expiresAt: Date | null = null
): Promise<void> {
  const sanction = await prisma.warning.create({
    data: { guildId, userId: targetId, type, reason, issuedById: actor.id, expiresAt },
  });

  await writeAudit(client, {
    guildId,
    action: type === "WARNING" ? "WARNING_ISSUED" : "REPRIMAND_ISSUED",
    actorId: actor.id,
    actorTag: actor.tag,
    targetType: "member",
    targetId,
    newValue: type,
    reason,
  });

  const settings = await getSettings(guildId);
  try {
    if (settings.disciplineChannelId) {
      const channel = await client.channels.fetch(settings.disciplineChannelId).catch(() => null);
      if (channel?.type === ChannelType.GuildText) {
        await channel.send({
          embeds: [
            warnEmbed(
              type === "WARNING" ? "⚠️ Предупреждение" : "🚫 Выговор",
              `Сотрудник: <@${targetId}>\nВыдал: <@${actor.id}>\nПричина: ${reason}\nДата: ${formatDateTime(sanction.createdAt)}\n\nАктивных взысканий: ${await prisma.warning.count({ where: { userId: targetId, active: true } })}`
            ),
          ],
        });
      }
    }
  } catch (err) {
    logger.warn("Не удалось опубликовать взыскание:", err);
  }

  await notifyUser(client, targetId,
    warnEmbed(
      type === "WARNING" ? "⚠️ Вам выдано предупреждение" : "🚫 Вам выдан выговор",
      `Причина: ${reason}\nВыдал: <@${actor.id}>`
    ));
}

export async function removeSanction(
  client: Client,
  guildId: string,
  sanctionId: number,
  actor: User,
  reason?: string
): Promise<void> {
  const sanction = await prisma.warning.findUnique({ where: { id: sanctionId } });
  if (!sanction || sanction.guildId !== guildId) throw new UserError("Взыскание не найдено.");
  if (!sanction.active) throw new UserError("Взыскание уже снято.");

  await prisma.warning.update({
    where: { id: sanctionId },
    data: { active: false, removedById: actor.id, removedAt: new Date() },
  });
  await writeAudit(client, {
    guildId,
    action: "SANCTION_REMOVED",
    actorId: actor.id,
    actorTag: actor.tag,
    targetType: "sanction",
    targetId: String(sanctionId),
    oldValue: sanction.type,
    newValue: "снято",
    reason: reason ?? null,
  });
  await notifyUser(client, sanction.userId,
    successEmbed("✅ Взыскание снято", `Взыскание #${sanctionId} снято.${reason ? `\nПричина: ${reason}` : ""}`));
}

export async function sanctionsBoardEmbed(guildId: string) {
  const active = await prisma.warning.findMany({
    where: { guildId, active: true },
    orderBy: { createdAt: "desc" },
    take: 15,
  });
  const embed = baseEmbed("⚠️ Дисциплина — активные взыскания").setColor(COLORS.DANGER);
  embed.setDescription(
    active.length === 0
      ? "Активных взысканий нет."
      : active
          .map((w) => `#${w.id} — <@${w.userId}> — **${w.type === "WARNING" ? "предупреждение" : "выговор"}** — ${formatDateTime(w.createdAt)}\nПричина: ${w.reason}`)
          .join("\n\n")
  );
  return embed;
}

// ─────────────────────────── Стажировка ───────────────────────────

export async function startInternship(client: Client, guildId: string, internId: string, mentorId: string, actor: User): Promise<void> {
  const existing = await prisma.internship.findFirst({
    where: { guildId, userId: internId, status: "ACTIVE" },
  });
  if (existing) throw new UserError("Стажировка этого сотрудника уже идёт.");

  await prisma.internship.create({ data: { guildId, userId: internId, mentorId } });
  await prisma.user.upsert({
    where: { discordId: internId },
    create: { discordId: internId, username: internId, internStartedAt: new Date(), mentorId },
    update: { internStartedAt: new Date(), mentorId },
  });

  await writeAudit(client, {
    guildId,
    action: "INTERNSHIP_UPDATED",
    actorId: actor.id,
    actorTag: actor.tag,
    targetType: "member",
    targetId: internId,
    newValue: "стажировка начата",
  });

  const settings = await getSettings(guildId);
  try {
    if (settings.internshipChannelId) {
      const channel = await client.channels.fetch(settings.internshipChannelId).catch(() => null);
      if (channel?.type === ChannelType.GuildText) {
        await channel.send({
          embeds: [
            successEmbed("📝 Начата стажировка", `Стажёр: <@${internId}>\nНаставник: <@${mentorId}>\nНачало: ${formatDateTime(new Date())}`),
          ],
        });
      }
    }
  } catch (err) {
    logger.warn("Не удалось опубликовать стажировку:", err);
  }
}

/// Завершение стажировки: COMPLETED | FAILED | PAUSED.
export async function finishInternship(
  client: Client,
  guildId: string,
  internId: string,
  status: "COMPLETED" | "FAILED" | "PAUSED",
  actor: User,
  note?: string
): Promise<void> {
  const internship = await prisma.internship.findFirst({
    where: { guildId, userId: internId, status: "ACTIVE" },
  });
  if (!internship) throw new UserError("Активная стажировка этого сотрудника не найдена.");

  await prisma.internship.update({
    where: { id: internship.id },
    data: { status, finishedAt: new Date(), note: note ?? null },
  });
  await prisma.user.update({
    where: { discordId: internId },
    data: { mentorId: null },
  }).catch(() => undefined);

  const label = status === "COMPLETED" ? "завершена ✅" : status === "FAILED" ? "не пройдена ❌" : "приостановлена ⏸";
  await writeAudit(client, {
    guildId,
    action: "INTERNSHIP_UPDATED",
    actorId: actor.id,
    actorTag: actor.tag,
    targetType: "member",
    targetId: internId,
    oldValue: "ACTIVE",
    newValue: status,
    reason: note ?? null,
  });

  const settings = await getSettings(guildId);
  const lines = [
    `Стажёр: <@${internId}>`,
    `Наставник: <@${internship.mentorId}>`,
    `Статус: **${label}**`,
    `Начало: ${formatDateTime(internship.startedAt)}`,
    note ? `Комментарий: ${note}` : "",
  ].filter(Boolean).join("\n");

  try {
    if (settings.internshipChannelId) {
      const channel = await client.channels.fetch(settings.internshipChannelId).catch(() => null);
      if (channel?.type === ChannelType.GuildText) {
        await channel.send({
          embeds: [status === "COMPLETED" ? successEmbed("📝 Стажировка завершена", lines) : warnEmbed("📝 Стажировка изменена", lines)],
        });
      }
    }
  } catch (err) {
    logger.warn("Не удалось опубликовать итог стажировки:", err);
  }

  await notifyUser(client, internId,
    status === "COMPLETED"
      ? successEmbed("🎓 Стажировка завершена", `Поздравляем! ${note ? `\nКомментарий: ${note}` : ""}`)
      : warnEmbed("Стажировка изменена", `Статус: ${label}${note ? `\nКомментарий: ${note}` : ""}`));
}

export async function internshipsEmbed(guildId: string) {
  const list = await prisma.internship.findMany({
    where: { guildId, status: "ACTIVE" },
    orderBy: { startedAt: "asc" },
  });
  const embed = baseEmbed("📝 Активные стажировки").setColor(COLORS.INFO);
  embed.setDescription(
    list.length === 0
      ? "Активных стажировок нет."
      : list
          .map((i) => `Стажёр: <@${i.userId}> — наставник: <@${i.mentorId}> — с ${formatDateTime(i.startedAt)}`)
          .join("\n")
  );
  return embed;
}

/// Состав отдела — из БД по фактическим должностям.
export async function rosterEmbed(guild: Guild) {
  const users = await prisma.user.findMany({
    where: { leftAt: null, position: { notIn: ["GUEST"] } },
    orderBy: { joinedAt: "asc" },
  });

  const groups: Record<string, string[]> = {};
  for (const u of users) {
    const pos = (u.position as Position) ?? "GUEST";
    if (pos === "GUEST") continue;
    (groups[pos] ??= []).push(`<@${u.discordId}>`);
  }

  const embed = baseEmbed("👤 Состав отдела организаторов").setColor(COLORS.BRAND);
  const order: Position[] = ["ADMIN", "CURATOR", "HEAD", "SENIOR", "ORGANIZER", "ASSISTANT"];
  for (const pos of order) {
    const members = groups[pos];
    if (members && members.length > 0) {
      embed.addFields({ name: `${POSITION_RU[pos]} (${members.length})`, value: members.join(", ").slice(0, 1000) });
    }
  }
  if (embed.data.fields?.length === 0) {
    embed.setDescription("Сотрудники ещё не добавлены в БД. Должности назначаются командой /promote.");
  }
  embed.setFooter({ text: `Всего в отделе: ${users.length}` });
  return embed;
}
