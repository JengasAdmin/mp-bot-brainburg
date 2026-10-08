import type { GuildMember, Snowflake } from "discord.js";
import type { GuildSettings, User as DbUser } from "@prisma/client";
import { prisma } from "../lib/db";
import { POSITION_RANK, type Position } from "../permissions/matrix";

const ROLE_TO_POSITION: Record<string, Position> = {
  roleMainAdminId: "ADMIN",
  roleCuratorId: "CURATOR",
  roleHeadOrganizerId: "HEAD",
  roleSeniorOrganizerId: "SENIOR",
  roleOrganizerId: "ORGANIZER",
  roleAssistantId: "ASSISTANT",
};

/// Создаёт/обновляет запись пользователя в БД.
export async function ensureUser(member: GuildMember): Promise<DbUser> {
  return prisma.user.upsert({
    where: { discordId: member.id },
    create: {
      discordId: member.id,
      username: member.user.username,
      nickname: member.displayName,
    },
    update: { username: member.user.username, nickname: member.displayName },
  });
}

export async function getUser(discordId: string): Promise<DbUser | null> {
  return prisma.user.findUnique({ where: { discordId } });
}

/// Определяет должность по Discord-ролям (источник истины — роли сервера).
export function resolvePosition(member: GuildMember, settings: GuildSettings): Position {
  let best: Position = "GUEST";
  for (const [settingsKey, position] of Object.entries(ROLE_TO_POSITION)) {
    const roleId = settings[settingsKey as keyof GuildSettings] as string | null;
    if (roleId && member.roles.cache.has(roleId) && POSITION_RANK[position] > POSITION_RANK[best]) {
      best = position;
    }
  }
  return best;
}

/// Синхронизирует должность в БД с фактическими ролями Discord.
export async function syncPosition(member: GuildMember, settings: GuildSettings): Promise<Position> {
  const position = resolvePosition(member, settings);
  await ensureUser(member);
  await prisma.user.updateMany({
    where: { discordId: member.id, position: { not: position } },
    data: { position },
  });
  return position;
}

export async function getPositionOf(userId: Snowflake): Promise<Position> {
  const user = await prisma.user.findUnique({ where: { discordId: userId } });
  return (user?.position as Position) ?? "GUEST";
}
