import {
  PermissionFlagsBits as P,
  type Guild,
  type OverwriteData,
  type PermissionResolvable,
  type Role,
} from "discord.js";
import type { GuildSettings } from "@prisma/client";

/// Разрешение групп ролей на каналы. Используется при /setup и при создании
/// каналов мероприятий.

export type AccessLevel =
  | "public"     // видят все члены отдела (включая кандидатов)
  | "work"       // рабочие каналы: кандидаты видят и пишут, проверка — у руководства
  | "staff"      // основной состав и выше (Помощник+)
  | "senior"     // проверка заявок: Старший+
  | "discipline" // дисциплина: Старший и руководство
  | "leadership" // руководство: Главный Организатор+ и Куратор/Админ
  | "logs"       // логи: руководство отдела
  | "manage";    // управление: только руководство

export interface RoleSet {
  everyone: Role;
  admin: Role;
  curator: Role;
  head: Role;
  senior: Role;
  organizer: Role;
  assistant: Role;
  testPassed: Role;
  testAccess: Role;
  dostup: Role;
  bot: Role;
}

const VIEW = P.ViewChannel;
const SEND = P.SendMessages;
const CONNECT = P.Connect;
const SPEAK = P.Speak;
const HISTORY = P.ReadMessageHistory;
const ATTACH = P.AttachFiles;
const EMBED = P.EmbedLinks;
const THREADS = P.CreatePublicThreads;

function allow(...flags: PermissionResolvable[]): PermissionResolvable[] {
  return flags;
}

function deny(...flags: PermissionResolvable[]): PermissionResolvable[] {
  return flags;
}

const staffRoles = (r: RoleSet) => [r.assistant, r.organizer, r.senior, r.head, r.curator, r.admin];
const leadershipRoles = (r: RoleSet) => [r.head, r.curator, r.admin];
const seniorRoles = (r: RoleSet) => [r.senior, r.head, r.curator, r.admin];
const candidateRoles = (r: RoleSet) => [r.dostup, r.testAccess, r.testPassed];

/// Строит permission overwrites для канала с заданным уровнем доступа.
/// write: могут ли участники отправлять сообщения (для read-only каналов false).
export function buildOverwrites(
  roles: RoleSet,
  access: AccessLevel,
  voice: boolean,
  write: boolean
): OverwriteData[] {
  const viewPerms = voice ? [VIEW, CONNECT, HISTORY] : [VIEW, HISTORY];
  const writePerms = voice
    ? [VIEW, CONNECT, SPEAK, HISTORY]
    : [VIEW, SEND, HISTORY, ATTACH, EMBED];
  const overwrites: OverwriteData[] = [];

  // Бот: полный доступ ко всем каналам.
  overwrites.push({
    id: roles.bot.id,
    allow: [VIEW, SEND, HISTORY, P.ManageChannels, P.ManageMessages, P.ManageThreads, CONNECT, SPEAK, P.MoveMembers, ATTACH, EMBED],
  });

  const grantRoles = (list: Role[], perms: PermissionResolvable[]) =>
    list.forEach((role) => overwrites.push({ id: role.id, allow: perms }));

  switch (access) {
    case "public": {
      overwrites.push({ id: roles.everyone.id, allow: viewPerms });
      if (write) {
        overwrites.push({ id: roles.everyone.id, allow: writePerms });
      } else {
        overwrites.push({ id: roles.everyone.id, deny: voice ? [SPEAK] : [SEND, ATTACH] });
        grantRoles(leadershipRoles(roles), writePerms);
      }
      break;
    }
    case "work": {
      overwrites.push({ id: roles.everyone.id, deny: [VIEW] });
      grantRoles(candidateRoles(roles), voice ? viewPerms : [...viewPerms, SEND, ATTACH, EMBED, THREADS]);
      grantRoles(staffRoles(roles), writePerms);
      break;
    }
    case "staff": {
      overwrites.push({ id: roles.everyone.id, deny: [VIEW] });
      grantRoles(staffRoles(roles), writePerms);
      break;
    }
    case "senior": {
      overwrites.push({ id: roles.everyone.id, deny: [VIEW] });
      grantRoles(seniorRoles(roles), writePerms);
      break;
    }
    case "discipline": {
      overwrites.push({ id: roles.everyone.id, deny: [VIEW] });
      grantRoles([roles.senior, ...leadershipRoles(roles)], writePerms);
      break;
    }
    case "leadership": {
      overwrites.push({ id: roles.everyone.id, deny: [VIEW] });
      grantRoles(leadershipRoles(roles), writePerms);
      break;
    }
    case "logs": {
      overwrites.push({ id: roles.everyone.id, deny: [VIEW] });
      grantRoles(leadershipRoles(roles), writePerms);
      break;
    }
    case "manage": {
      overwrites.push({ id: roles.everyone.id, deny: [VIEW] });
      grantRoles(leadershipRoles(roles), writePerms);
      break;
    }
  }

  return overwrites;
}

/// Собирает RoleSet из GuildSettings + гильдии. Бросает понятную ошибку,
/// если какая-то роль не найдена (удалена вручную).
export function resolveRoleSet(guild: Guild, settings: GuildSettings): RoleSet {
  const pick = (id: string | null, name: string): Role => {
    if (!id) throw new Error(`Роль «${name}» не настроена. Выполните /setup.`);
    const role = guild.roles.cache.get(id);
    if (!role) throw new Error(`Роль «${name}» не найдена на сервере (удалена?). Выполните /setup повторно.`);
    return role;
  };
  return {
    everyone: guild.roles.everyone,
    admin: pick(settings.roleMainAdminId, "Главная Администрация"),
    curator: pick(settings.roleCuratorId, "Куратор"),
    head: pick(settings.roleHeadOrganizerId, "Главный Организатор МП"),
    senior: pick(settings.roleSeniorOrganizerId, "Старший Организатор МП"),
    organizer: pick(settings.roleOrganizerId, "Организатор МП"),
    assistant: pick(settings.roleAssistantId, "Помощник Организаторов"),
    testPassed: pick(settings.roleTestPassedId, "Пройденный тест"),
    testAccess: pick(settings.roleTestAccessId, "Доступ к тесту"),
    dostup: pick(settings.roleDostupId, "dostup"),
    bot: pick(settings.roleBotId, "MP Организатор"),
  };
}
