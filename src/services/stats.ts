import { prisma } from "../lib/db";
import { baseEmbed, COLORS } from "../lib/embeds";
import { formatDateTime } from "../lib/time";
import { STATUS_RU, STATUS } from "../constants";
import { DONE_STATUSES, STATS_PERIOD_RU, periodRange, type StatsPeriod } from "./rules";

export interface StatsSnapshot {
  period: StatsPeriod;
  periodLabel: string;
  /// Все времена
  totalAll: number;
  completedAll: number;
  /// За период
  created: number;
  completed: number;
  cancelled: number;
  rejected: number;
  pending: number;
  active: number;
  planned: number;
  totalParticipants: number;
  avgAttendance: number;
  week: number;
  month: number;
  byCategory: { name: string; emoji: string; count: number; participants: number }[];
  topOrganizers: { userId: string; count: number }[];
}

export async function computeStats(guildId: string, period: StatsPeriod = "all"): Promise<StatsSnapshot> {
  const { from } = periodRange(period);
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 3600_000);
  const monthAgo = new Date(now.getTime() - 30 * 24 * 3600_000);

  const createdWhere = { guildId, ...(from ? { createdAt: { gte: from } } : {}) };
  const finishedWhere = { guildId, status: { in: DONE_STATUSES }, ...(from ? { finishedAt: { gte: from } } : {}) };

  const [
    totalAll,
    completedAll,
    created,
    completed,
    cancelled,
    rejected,
    pending,
    active,
    planned,
    participantsAgg,
    week,
    month,
    topRaw,
    categoryGroups,
    categoriesRaw,
  ] = await Promise.all([
    prisma.event.count({ where: { guildId } }),
    prisma.event.count({ where: { guildId, status: { in: DONE_STATUSES } } }),
    prisma.event.count({ where: createdWhere }),
    prisma.event.count({ where: finishedWhere }),
    prisma.event.count({
      where: { guildId, status: STATUS.CANCELLED, ...(from ? { cancelledAt: { gte: from } } : {}) },
    }),
    prisma.event.count({
      where: { guildId, status: STATUS.REJECTED, ...(from ? { createdAt: { gte: from } } : {}) },
    }),
    prisma.event.count({ where: { guildId, status: { in: [STATUS.PENDING, STATUS.REVISION] } } }),
    prisma.event.count({ where: { guildId, status: STATUS.ACTIVE } }),
    prisma.event.count({ where: { guildId, status: { in: [STATUS.APPROVED, STATUS.PLANNED] } } }),
    prisma.eventReport.aggregate({
      where: { event: { guildId, ...(from ? { finishedAt: { gte: from } } : {}) } },
      _sum: { participantsActual: true },
      _count: { eventId: true },
    }),
    prisma.event.count({ where: { guildId, status: { in: DONE_STATUSES }, finishedAt: { gte: weekAgo } } }),
    prisma.event.count({ where: { guildId, status: { in: DONE_STATUSES }, finishedAt: { gte: monthAgo } } }),
    prisma.event.groupBy({
      by: ["organizerId"],
      where: finishedWhere,
      _count: { organizerId: true },
      orderBy: { _count: { organizerId: "desc" } },
      take: 5,
    }),
    prisma.event.groupBy({
      by: ["categoryId"],
      where: finishedWhere,
      _count: { categoryId: true },
    }),
    prisma.eventReport.findMany({
      where: {
        event: { guildId, status: { in: DONE_STATUSES }, ...(from ? { finishedAt: { gte: from } } : {}) },
      },
      select: { participantsActual: true, event: { select: { categoryId: true } } },
    }),
  ]);

  const totalParticipants = participantsAgg._sum.participantsActual ?? 0;
  const reportCount = participantsAgg._count.eventId;

  const categoryMeta = await prisma.eventCategory.findMany({ where: { guildId } });
  const metaById = new Map(categoryMeta.map((c) => [c.id, c]));

  const participantsByCategory = new Map<number, number>();
  for (const r of categoriesRaw) {
    const catId = r.event.categoryId;
    participantsByCategory.set(catId, (participantsByCategory.get(catId) ?? 0) + r.participantsActual);
  }

  const byCategory = categoryGroups
    .map((g) => {
      const meta = metaById.get(g.categoryId);
      return {
        name: meta?.name ?? `Категория #${g.categoryId}`,
        emoji: meta?.emoji ?? "🎲",
        count: g._count.categoryId,
        participants: participantsByCategory.get(g.categoryId) ?? 0,
      };
    })
    .sort((a, b) => b.count - a.count);

  return {
    period,
    periodLabel: STATS_PERIOD_RU[period],
    totalAll,
    completedAll,
    created,
    completed,
    cancelled,
    rejected,
    pending,
    active,
    planned,
    totalParticipants,
    avgAttendance: reportCount > 0 ? Math.round(totalParticipants / reportCount) : 0,
    week,
    month,
    byCategory,
    topOrganizers: topRaw
      .filter((r) => r.organizerId)
      .map((r) => ({
        userId: r.organizerId as string,
        count: (r._count as { organizerId?: number } | null)?.organizerId ?? 0,
      })),
  };
}

export async function statsEmbed(guildId: string, guildName: string, period: StatsPeriod = "all") {
  const s = await computeStats(guildId, period);
  const embed = baseEmbed(`📈 Статистика отдела — ${guildName}`).setColor(COLORS.INFO);
  embed.setDescription(`**Период:** ${s.periodLabel}`);

  embed.addFields(
    { name: "Всего МП (за всё время)", value: String(s.totalAll), inline: true },
    { name: "Проведено (за всё время)", value: String(s.completedAll), inline: true },
    { name: "За период: создано", value: String(s.created), inline: true },
    { name: "Проведено за период", value: String(s.completed), inline: true },
    { name: "Отменено", value: String(s.cancelled), inline: true },
    { name: "Отклонено", value: String(s.rejected), inline: true },
    { name: "На проверке", value: String(s.pending), inline: true },
    { name: "Активные сейчас", value: String(s.active), inline: true },
    { name: "Запланировано", value: String(s.planned), inline: true }
  );

  embed.addFields(
    { name: "Участников за период", value: String(s.totalParticipants), inline: true },
    { name: "Средняя посещаемость", value: String(s.avgAttendance), inline: true },
    { name: "МП за неделю / месяц", value: `${s.week} / ${s.month}`, inline: true }
  );

  if (s.byCategory.length > 0) {
    embed.addFields({
      name: "По категориям (за период)",
      value: s.byCategory
        .slice(0, 10)
        .map((c) => `${c.emoji} **${c.name}** — ${c.count} МП, ${c.participants} участников`)
        .join("\n"),
    });
  }

  embed.addFields({
    name: "Лучшие организаторы (за период)",
    value:
      s.topOrganizers.length > 0
        ? s.topOrganizers.map((o, i) => `${i + 1}. <@${o.userId}> — ${o.count} МП`).join("\n")
        : "—",
  });

  embed.setFooter({ text: `Рассчитано из БД • ${formatDateTime(new Date())}` });
  return embed;
}

export async function statsBoardEmbed(guildId: string, guildName: string) {
  const embed = await statsEmbed(guildId, guildName, "all");
  embed.setFooter({ text: `Обновляется автоматически • ${formatDateTime(new Date())}` });
  return embed;
}
