import {
  ChannelType,
  type Guild,
  type Role,
  type CategoryChannel,
  type TextChannel,
  type VoiceChannel,
} from "discord.js";
import { prisma } from "../lib/db";
import { CATEGORY_DEFS, DEFAULT_ACHIEVEMENTS, DEFAULT_EVENT_CATEGORIES, ROLE_DEFS, VOICE_CATEGORY } from "../constants";
import { buildOverwrites, type AccessLevel, type RoleSet } from "../permissions/channelAccess";
import { getSettings, updateSettings } from "../services/settings";
import { logger } from "../lib/logger";

/// Ядро настройки сервера. Используется командой /setup и восстановлением
/// после рестарта. Идемпотентно: ищет объекты по именам, создаёт недостающие
/// (createMissing), обновляет права и ID в БД, дубликаты не создаёт.

export interface SetupOptions {
  /// Создавать отсутствующие роли/каналы. false — только перепривязать существующие.
  createMissing?: boolean;
  /// Обновлять permission overwrites у найденных каналов.
  syncPermissions?: boolean;
}

export interface SetupReport {
  rolesCreated: number;
  rolesFound: number;
  categoriesCreated: number;
  categoriesFound: number;
  channelsCreated: number;
  channelsFound: number;
  channelsUpdated: number;
  dbFieldsUpdated: number;
  missing: string[];
  errors: string[];
}

interface RoleSetShim extends RoleSet {}

const channelKindToAccess = (kind: string, categoryAccess: AccessLevel): AccessLevel => {
  switch (kind) {
    case "review": return "senior";
    case "discipline": return "discipline";
    case "logs": return "logs";
    case "manage": return "manage";
    case "leadership-chat": return "leadership";
    case "ideas":
    case "applications":
    case "work": return "work";
    case "staff":
    case "stats":
    case "roster":
    case "achievements":
    case "promotions":
    case "internship":
    case "board": return "staff";
    case "testing": return "work";
    case "commands":
    case "category-chat": return "public";
    case "announcements":
    case "readonly": return "public";
    default: return categoryAccess;
  }
};

const WRITABLE_KINDS = new Set(["ideas", "applications", "work", "testing", "leadership-chat", "commands", "category-chat"]);
const channelKindToWrite = (kind: string): boolean => WRITABLE_KINDS.has(kind);

export async function performSetup(
  guild: Guild,
  options: SetupOptions = {}
): Promise<SetupReport> {
  const createMissing = options.createMissing ?? true;
  const syncPermissions = options.syncPermissions ?? true;

  const report: SetupReport = {
    rolesCreated: 0,
    rolesFound: 0,
    categoriesCreated: 0,
    categoriesFound: 0,
    channelsCreated: 0,
    channelsFound: 0,
    channelsUpdated: 0,
    dbFieldsUpdated: 0,
    missing: [],
    errors: [],
  };

  // ── 1. Роли (создаются снизу вверх для корректной иерархии) ──
  const roleIds: Record<string, string> = {};
  for (const def of [...ROLE_DEFS].reverse()) {
    const existing = guild.roles.cache.find((r) => r.name === def.name && !r.managed);
    if (existing) {
      roleIds[def.key] = existing.id;
      report.rolesFound++;
      if (existing.hexColor !== def.color.toLowerCase()) {
        await existing.setColor(def.color as `#${string}`, "Синхронизация цвета роли").catch(() => undefined);
      }
      continue;
    }
    if (!createMissing) {
      report.missing.push(`роль «${def.name}»`);
      continue;
    }
    try {
      const role = await guild.roles.create({
        name: def.name,
        color: def.color as `#${string}`,
        hoist: def.hoist,
        mentionable: false,
        reason: "Создание структуры отдела",
      });
      roleIds[def.key] = role.id;
      report.rolesCreated++;
    } catch (err) {
      report.errors.push(`не удалось создать роль «${def.name}»: ${String(err)}`);
    }
  }

  const pickRole = (key: string, name: string): Role | null => {
    const id = roleIds[key];
    const role = id ? guild.roles.cache.get(id) : undefined;
    if (!role) {
      if (!report.missing.includes(`роль «${name}»`)) report.missing.push(`роль «${name}»`);
      return null;
    }
    return role;
  };

  const roleSet: RoleSetShim | null = (() => {
    const parts: Record<string, Role | null> = {
      everyone: guild.roles.everyone,
      admin: pickRole("roleMainAdminId", "Главная Администрация"),
      curator: pickRole("roleCuratorId", "Куратор"),
      head: pickRole("roleHeadOrganizerId", "Главный Организатор МП"),
      senior: pickRole("roleSeniorOrganizerId", "Старший Организатор МП"),
      organizer: pickRole("roleOrganizerId", "Организатор МП"),
      assistant: pickRole("roleAssistantId", "Помощник Организаторов"),
      testPassed: pickRole("roleTestPassedId", "Пройденный тест"),
      testAccess: pickRole("roleTestAccessId", "Доступ к тесту"),
      dostup: pickRole("roleDostupId", "dostup"),
      bot: pickRole("roleBotId", "MP Организатор"),
    };
    if (Object.values(parts).some((r) => !r)) return null;
    return parts as unknown as RoleSetShim;
  })();

  if (!roleSet) {
    report.errors.push("Часть ролей недоступна — настройка каналов пропущена. Выполните /setup после восстановления ролей.");
    return report;
  }

  // Боту выдаётся его техническая роль (иерархия: роль бота должна быть выше создаваемых).
  const botRole = guild.roles.cache.get(roleIds.roleBotId);
  const me = guild.members.me;
  if (botRole && me && !me.roles.cache.has(botRole.id)) {
    await me.roles.add(botRole, "Назначение роли бота").catch((err) => report.errors.push(`не удалось выдать роль боту: ${String(err)}`));
  }

  // ── 2. Текстовые категории и каналы ──
  const channelIds: Record<string, string> = {};

  for (const cat of CATEGORY_DEFS) {
    const category = await findOrCreateCategory(guild, cat.name, roleSet, cat.access as AccessLevel, createMissing, syncPermissions, report);
    if (!category) continue;
    for (const ch of cat.channels) {
      const id = await findOrCreateTextChannel(
        guild, ch.name, category.id, roleSet, ch.kind, cat.access as AccessLevel, createMissing, syncPermissions, report
      );
      if (id && ch.key) channelIds[ch.key] = id;
    }
  }

  // ── 3. Голосовые ──
  const voiceCategory = await findOrCreateCategory(guild, VOICE_CATEGORY.name, roleSet, "public", createMissing, syncPermissions, report);
  if (voiceCategory) {
    for (const ch of VOICE_CATEGORY.channels) {
      const id = await findOrCreateVoiceChannel(
        guild, ch.name, voiceCategory.id, roleSet, ch.access as AccessLevel, createMissing, syncPermissions, report
      );
      if (id && ch.key) channelIds[ch.key] = id;
    }
  }

  // ── 4. БД: настройки, категории МП, достижения ──
  const settings = await getSettings(guild.id);
  const fields: Record<string, string | boolean | Date> = {};
  for (const [key, id] of Object.entries(channelIds)) {
    if ((settings as unknown as Record<string, string | null>)[key] !== id) {
      fields[key] = id;
      report.dbFieldsUpdated++;
    }
  }
  for (const [key, id] of Object.entries(roleIds)) {
    if ((settings as unknown as Record<string, string | null>)[key] !== id) {
      fields[key] = id;
      report.dbFieldsUpdated++;
    }
  }
  if (createMissing && (Object.keys(fields).length > 0 || !settings.setupComplete)) {
    fields.setupComplete = true;
    fields.setupAt = new Date();
  }
  if (Object.keys(fields).length > 0) {
    await updateSettings(guild.id, fields as never);
  }

  if (createMissing) {
    for (const cat of DEFAULT_EVENT_CATEGORIES) {
      await prisma.eventCategory.upsert({
        where: { guildId_name: { guildId: guild.id, name: cat.name } },
        create: { guildId: guild.id, name: cat.name, emoji: cat.emoji },
        update: { active: true },
      });
    }
    for (const a of DEFAULT_ACHIEVEMENTS) {
      await prisma.achievement.upsert({
        where: { code: a.code },
        create: { ...a },
        update: { active: true },
      });
    }
  }

  return report;
}

// ─────────────────────────── Поиск/создание объектов ───────────────────────────

async function findOrCreateCategory(
  guild: Guild,
  name: string,
  roles: RoleSet,
  access: AccessLevel,
  createMissing: boolean,
  syncPermissions: boolean,
  report: SetupReport
): Promise<CategoryChannel | null> {
  const existing = guild.channels.cache.find(
    (c): c is CategoryChannel => c.name === name && c.type === ChannelType.GuildCategory
  );
  if (existing) {
    report.categoriesFound++;
    if (syncPermissions) {
      await existing.permissionOverwrites.set(buildOverwrites(roles, access, false, false)).catch(() => undefined);
    }
    return existing;
  }
  if (!createMissing) {
    report.missing.push(`категория «${name}»`);
    return null;
  }
  try {
    const created = await guild.channels.create({
      name,
      type: ChannelType.GuildCategory,
      permissionOverwrites: buildOverwrites(roles, access, false, false),
      reason: "Создание структуры отдела",
    });
    report.categoriesCreated++;
    return created as CategoryChannel;
  } catch (err) {
    report.errors.push(`не удалось создать категорию «${name}»: ${String(err)}`);
    return null;
  }
}

async function findOrCreateTextChannel(
  guild: Guild,
  name: string,
  parentId: string,
  roles: RoleSet,
  kind: string,
  categoryAccess: AccessLevel,
  createMissing: boolean,
  syncPermissions: boolean,
  report: SetupReport
): Promise<string | null> {
  const access = channelKindToAccess(kind, categoryAccess);
  const overwrites = buildOverwrites(roles, access, false, channelKindToWrite(kind));

  const existing = guild.channels.cache.find((c) => c.name === name && c.type === ChannelType.GuildText);
  if (existing) {
    report.channelsFound++;
    const channel = existing as TextChannel;
    if (syncPermissions) {
      const changed = await channel.permissionOverwrites.set(overwrites).then(() => true).catch(() => false);
      if (changed) report.channelsUpdated++;
    }
    if (channel.parentId !== parentId) {
      await channel.setParent(parentId, { lockPermissions: false }).catch(() => undefined);
    }
    return channel.id;
  }
  if (!createMissing) {
    report.missing.push(`канал «${name}»`);
    return null;
  }
  try {
    const created = await guild.channels.create({
      name,
      type: ChannelType.GuildText,
      parent: parentId,
      permissionOverwrites: overwrites,
      reason: "Создание структуры отдела",
    });
    report.channelsCreated++;
    return created.id;
  } catch (err) {
    report.errors.push(`не удалось создать канал «${name}»: ${String(err)}`);
    return null;
  }
}

async function findOrCreateVoiceChannel(
  guild: Guild,
  name: string,
  parentId: string,
  roles: RoleSet,
  access: AccessLevel,
  createMissing: boolean,
  syncPermissions: boolean,
  report: SetupReport
): Promise<string | null> {
  const overwrites = buildOverwrites(roles, access, true, true);

  const existing = guild.channels.cache.find((c) => c.name === name && c.type === ChannelType.GuildVoice);
  if (existing) {
    report.channelsFound++;
    const channel = existing as VoiceChannel;
    if (syncPermissions) {
      const changed = await channel.permissionOverwrites.set(overwrites).then(() => true).catch(() => false);
      if (changed) report.channelsUpdated++;
    }
    if (channel.parentId !== parentId) {
      await channel.setParent(parentId, { lockPermissions: false }).catch(() => undefined);
    }
    return channel.id;
  }
  if (!createMissing) {
    report.missing.push(`голосовой канал «${name}»`);
    return null;
  }
  try {
    const created = await guild.channels.create({
      name,
      type: ChannelType.GuildVoice,
      parent: parentId,
      permissionOverwrites: overwrites,
      reason: "Создание структуры отдела",
    });
    report.channelsCreated++;
    return created.id;
  } catch (err) {
    report.errors.push(`не удалось создать голосовой канал «${name}»: ${String(err)}`);
    return null;
  }
}

export function describeReport(r: SetupReport): string {
  return [
    `Роли: найдено ${r.rolesFound}, создано ${r.rolesCreated}`,
    `Категории: найдено ${r.categoriesFound}, создано ${r.categoriesCreated}`,
    `Каналы: найдено ${r.channelsFound}, создано ${r.channelsCreated}, обновлено прав: ${r.channelsUpdated}`,
    `Полей настроек обновлено в БД: ${r.dbFieldsUpdated}`,
    r.missing.length > 0 ? `Не найдено: ${r.missing.join(", ")}` : "",
    r.errors.length > 0 ? `Ошибки: ${r.errors.join("; ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export { logger };
