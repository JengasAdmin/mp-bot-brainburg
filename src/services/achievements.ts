import { ChannelType, type Client } from "discord.js";
import { prisma } from "../lib/db";
import { baseEmbed, successEmbed, COLORS } from "../lib/embeds";
import { logger } from "../lib/logger";
import { writeAudit } from "./audit";
import { getSettings } from "./settings";

/// Пересчитывает достижения сотрудника по метрикам из БД и выдаёт новые.
/// Расширяемо: новые достижения добавляются записью в таблицу Achievement.
export async function evaluateAchievements(client: Client, guildId: string, userId: string): Promise<string[]> {
  try {
    const [completedAsOrganizer, reports, achievements, existing] = await Promise.all([
      prisma.event.count({
        where: {
          guildId,
          organizerId: userId,
          status: { in: ["COMPLETED", "REPORTED", "ARCHIVED"] },
        },
      }),
      prisma.eventReport.count({ where: { createdById: userId } }),
      prisma.achievement.findMany({ where: { active: true } }),
      prisma.userAchievement.findMany({ where: { userId }, select: { achievementId: true } }),
    ]);

    const participantsAgg = await prisma.eventReport.aggregate({
      where: { createdById: userId },
      _sum: { participantsActual: true },
    });

    const metrics: Record<string, number> = {
      EVENTS_COMPLETED: completedAsOrganizer,
      PARTICIPANTS_TOTAL: participantsAgg._sum.participantsActual ?? 0,
      REPORTS: reports,
    };

    const owned = new Set(existing.map((e) => e.achievementId));
    const awarded: string[] = [];

    for (const achievement of achievements) {
      if (owned.has(achievement.id)) continue;
      const value = metrics[achievement.metric];
      if (value === undefined || value < achievement.threshold) continue;

      await prisma.userAchievement.create({
        data: { userId, achievementId: achievement.id },
      }).catch(() => null); // уникальный индекс защищает от гонки
      awarded.push(`${achievement.emoji} **${achievement.title}** — ${achievement.description}`);

      await writeAudit(client, {
        guildId,
        action: "ACHIEVEMENT_AWARDED",
        targetType: "achievement",
        targetId: achievement.code,
        newValue: achievement.title,
      });
    }

    if (awarded.length > 0) {
      try {
        const settings = await getSettings(guildId);
        if (settings.achievementsChannelId) {
          const channel = await client.channels.fetch(settings.achievementsChannelId).catch(() => null);
          if (channel?.type === ChannelType.GuildText) {
            await channel.send({
              content: `<@${userId}>`,
              embeds: [
                successEmbed(
                  "🏆 Новое достижение!",
                  `Сотрудник <@${userId}> получает:\n${awarded.join("\n")}`
                ),
              ],
            });
          }
        }
      } catch (err) {
        logger.warn("Не удалось отправить уведомление о достижении:", err);
      }
    }

    return awarded;
  } catch (err) {
    logger.error("Ошибка пересчёта достижений:", err);
    return [];
  }
}

export async function listAchievements(userId: string) {
  return prisma.userAchievement.findMany({
    where: { userId },
    include: { achievement: true },
    orderBy: { awardedAt: "asc" },
  });
}

export async function achievementsBoardEmbed(): Promise<ReturnType<typeof baseEmbed>> {
  const achievements = await prisma.achievement.findMany({ where: { active: true }, orderBy: { threshold: "asc" } });
  const counts = await prisma.userAchievement.groupBy({
    by: ["achievementId"],
    _count: { userId: true },
  });
  const countMap = new Map(counts.map((c) => [c.achievementId, c._count.userId]));

  const embed = baseEmbed("🏆 Достижения отдела").setColor(COLORS.BRAND);
  embed.setDescription(
    achievements
      .map((a) => `${a.emoji} **${a.title}** — ${a.description} *(получили: ${countMap.get(a.id) ?? 0})*`)
      .join("\n") || "Достижения пока не настроены."
  );
  embed.setFooter({ text: "Система расширяемая • Отдел организаторов МП Arizona" });
  return embed;
}
