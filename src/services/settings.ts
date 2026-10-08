import type { GuildSettings } from "@prisma/client";
import { prisma } from "../lib/db";
import { UserError } from "../lib/errors";

export async function getSettings(guildId: string): Promise<GuildSettings> {
  const existing = await prisma.guildSettings.findUnique({ where: { guildId } });
  if (existing) return existing;
  return prisma.guildSettings.create({ data: { guildId } });
}

export async function updateSettings(
  guildId: string,
  data: Partial<Omit<GuildSettings, "id" | "guildId">>
): Promise<GuildSettings> {
  await getSettings(guildId);
  return prisma.guildSettings.update({ where: { guildId }, data });
}

const CHANNEL_LABELS: Record<string, string> = {
  announcementsChannelId: "📢・объявления",
  announceChannelId: "📣・анонсы-мп",
  rulesChannelId: "📜・правила",
  regulationsChannelId: "📚・регламент",
  learningChannelId: "📖・обучение",
  faqChannelId: "❓・faq",
  ideasChannelId: "💡・идеи-мп",
  applicationsChannelId: "📝・заявки-на-мп",
  reviewChannelId: "🔍・проверка-мп",
  planningChannelId: "📅・планирование",
  activeChannelId: "🎯・активные-мп",
  statsChannelId: "📈・статистика",
  achievementsChannelId: "🏆・достижения",
  rosterChannelId: "👤・состав",
  internshipChannelId: "📝・стажировка",
  testingChannelId: "🎓・тестирование",
  promotionsChannelId: "⭐・повышения",
  disciplineChannelId: "⚠️・дисциплина",
  logsChannelId: "📜・логи",
  settingsChannelId: "⚙️・настройки",
  commandsChannelId: "🤖・команды",
  voiceGeneralId: "🔊・Общий",
  voiceOrganizersId: "🎙️・Организаторы",
  voiceEventsId: "🎯・Проведение МП",
  voiceLeadershipId: "👑・Руководство",
  voicePrivateId: "🔒・Закрытая",
};

/// Возвращает ID канала или бросает ошибку с указанием выполнить /setup.
export function requireChannel(settings: GuildSettings, key: string): string {
  const record = settings as unknown as Record<string, string | null>;
  const id = record[key];
  if (!id) throw new UserError(`Канал «${CHANNEL_LABELS[key] ?? key}» не настроен. Выполните /setup.`);
  return id;
}
