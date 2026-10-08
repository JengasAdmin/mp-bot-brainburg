import {
  PermissionFlagsBits,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
} from "discord.js";
import { findEvent, type EventWithCategory } from "../services/events";
import { UserError } from "../lib/errors";
import type { InteractionContext } from "../interactions/shared";
import { hasAtLeast, type Position } from "../permissions/matrix";
import { prisma } from "../lib/db";

/// Видимость slash-команд в Discord (UX, не защита):
/// реальная проверка прав всегда выполняется в бэкенде через requirePermission.
export const VIS_ADMIN = PermissionFlagsBits.Administrator;      // /setup
export const VIS_LEADERSHIP = PermissionFlagsBits.ManageGuild;   // кадры, архив, логи
export const VIS_STAFF = PermissionFlagsBits.ManageMessages;     // проверка заявок, управление МП

/// Позиции, управляющие мероприятием: автор, организатор или проверяющие.
export function canManageEvent(ctx: InteractionContext, event: EventWithCategory): boolean {
  const reviewer = hasAtLeast(ctx.position, "SENIOR");
  const mine = ctx.userId === event.authorId || ctx.userId === event.organizerId;
  return reviewer || mine;
}

export function assertCanManageEvent(ctx: InteractionContext, event: EventWithCategory): void {
  if (!canManageEvent(ctx, event)) {
    throw new UserError("Управлять мероприятием может его автор, организатор или руководство (Старший Организатор и выше).");
  }
}

/// Читает опцию «event» (код MP-XXXX или числовой ID) и возвращает мероприятие.
export async function eventFromOption(
  interaction: ChatInputCommandInteraction,
  optionName = "event"
): Promise<EventWithCategory> {
  const raw = interaction.options.getString(optionName, true);
  if (!interaction.guildId) throw new UserError("Команда доступна только на сервере.");
  return findEvent(interaction.guildId, raw);
}

/// Автодополнение кодов мероприятий (MP-XXXX) и названий.
export async function autocompleteEvents(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused().toLowerCase();
  if (!interaction.guildId) return interaction.respond([]);

  const events = await prisma.event.findMany({
    where: {
      guildId: interaction.guildId,
      ...(focused ? { OR: [{ code: { contains: focused } }, { title: { contains: focused } }] } : {}),
    },
    orderBy: { id: "desc" },
    take: 25,
    select: { code: true, title: true, status: true },
  });

  await interaction.respond(
    events.map((e) => ({
      name: `${e.code} — ${e.title}`.slice(0, 100),
      value: e.code,
    }))
  );
}

/// Автодополнение сотрудников отдела (из БД — источник истины по должностям).
export async function autocompleteStaff(interaction: AutocompleteInteraction, minRank: Position = "ASSISTANT"): Promise<void> {
  const focused = interaction.options.getFocused().toLowerCase();
  const users = await prisma.user.findMany({
    where: {
      leftAt: null,
      position: { not: "GUEST" },
      ...(focused
        ? { OR: [{ nickname: { contains: focused } }, { username: { contains: focused } }, { discordId: focused }] }
        : {}),
    },
    orderBy: { position: "desc" },
    take: 25,
  });

  const allowed = users.filter((u) => {
    const pos = u.position as Position;
    return ["ADMIN", "CURATOR", "HEAD", "SENIOR", "ORGANIZER", "ASSISTANT"].includes(pos) && hasAtLeast(pos, minRank);
  });

  await interaction.respond(
    allowed.map((u) => ({
      name: `${u.nickname ?? u.username} (${u.position})`.slice(0, 100),
      value: u.discordId,
    }))
  );
}
