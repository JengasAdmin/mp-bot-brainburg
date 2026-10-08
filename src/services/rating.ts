import type { Client } from "discord.js";
import type { Event, EventCategory, EventReport } from "@prisma/client";
import { prisma } from "../lib/db";
import { logger } from "../lib/logger";
import { writeAudit } from "./audit";
import { notifyUser } from "./notifications";
import { baseEmbed, withFooter } from "../lib/embeds";
import { COLORS } from "../constants";

// ─────────────────────────── Конфигурация очков ───────────────────────────

export const POINTS = {
  BASE: 10,           // за проведение МП
  REPORT: 5,          // за сданный отчёт
  ON_TIME: 3,         // за своевременный отчёт
  CATEGORY_BONUS: {   // бонус за категорию
    "Мафия": 2,
    "Рисовалки": 1,
    "Отгадай": 1,
    "Конкурсы": 3,
    "Другое": 0,
  } as Record<string, number>,
};

// ─────────────────────────── Начисление очков ───────────────────────────

/**
 * Подсчитывает очки за завершённое МП.
 * Учитывает категорию, наличие отчёта и своевременность сдачи.
 */
export function calculateEventPoints(
  event: Event,
  category: EventCategory,
  report: EventReport | null
): { points: number; breakdown: string[] } {
  const breakdown: string[] = [];
  let points = 0;

  // Базовые очки за проведение
  points += POINTS.BASE;
  breakdown.push(`Базовые очки за МП: +${POINTS.BASE}`);

  // Бонус за категорию
  const categoryBonus = POINTS.CATEGORY_BONUS[category.name] ?? 0;
  if (categoryBonus > 0) {
    points += categoryBonus;
    breakdown.push(`Бонус за категорию «${category.name}»: +${categoryBonus}`);
  }

  // Очки за отчёт
  if (report) {
    points += POINTS.REPORT;
    breakdown.push(`Отчёт сдан: +${POINTS.REPORT}`);

    // Проверка своевременности
    if (event.reportDueAt && report.createdAt <= event.reportDueAt) {
      points += POINTS.ON_TIME;
      breakdown.push(`Отчёт сдан вовремя: +${POINTS.ON_TIME}`);
    }
  }

  return { points, breakdown };
}

/**
 * Начисляет очки организатору за завершённое МП.
 * Вызывается при завершении МП (finishEvent) и при сдаче отчёта.
 */
export async function awardEventPoints(
  client: Client,
  event: Event,
  category: EventCategory,
  report: EventReport | null
): Promise<void> {
  const { points, breakdown } = calculateEventPoints(event, category, report);
  const userId = event.organizerId ?? event.authorId;

  // Начисляем очки за все периоды
  const periods = ["WEEKLY", "MONTHLY", "ALL_TIME"] as const;
  for (const period of periods) {
    await prisma.organizerRating.upsert({
      where: {
        guildId_userId_period: {
          guildId: event.guildId,
          userId,
          period,
        },
      },
      create: {
        guildId: event.guildId,
        userId,
        period,
        points,
        eventsCompleted: 1,
        reportsOnTime: report && event.reportDueAt && report.createdAt <= event.reportDueAt ? 1 : 0,
        reportsLate: report && event.reportDueAt && report.createdAt > event.reportDueAt ? 1 : 0,
      },
      update: {
        points: { increment: points },
        eventsCompleted: { increment: 1 },
        reportsOnTime: {
          increment: report && event.reportDueAt && report.createdAt <= event.reportDueAt ? 1 : 0,
        },
        reportsLate: {
          increment: report && event.reportDueAt && report.createdAt > event.reportDueAt ? 1 : 0,
        },
      },
    });
  }

  // Уведомляем организатора
  await notifyUser(client, userId, baseEmbed("⭐ Начислены очки рейтинга")
    .setColor(COLORS.BRAND)
    .setDescription(
      `**МП:** ${event.title} (${event.code})\n` +
      `**Начислено:** +${points} очков\n\n` +
      breakdown.map((b) => `• ${b}`).join("\n")
    ));

  // Аудит
  await writeAudit(client, {
    guildId: event.guildId,
    action: "RATING_POINTS_AWARDED",
    actorId: userId,
    targetType: "event",
    targetId: event.code,
    newValue: `+${points} очков`,
  });

  logger.info(`Начислено ${points} очков организатору ${userId} за МП ${event.code}`);
}

/**
 * Начисляет очки за сданный отчёт (бонус за отчёт и своевременность).
 */
export async function awardReportPoints(
  client: Client,
  event: Event,
  report: EventReport
): Promise<void> {
  const userId = event.organizerId ?? event.authorId;
  let points = 0;
  const breakdown: string[] = [];

  // Очки за отчёт
  points += POINTS.REPORT;
  breakdown.push(`Отчёт сдан: +${POINTS.REPORT}`);

  // Проверка своевременности
  if (event.reportDueAt && report.createdAt <= event.reportDueAt) {
    points += POINTS.ON_TIME;
    breakdown.push(`Отчёт сдан вовремя: +${POINTS.ON_TIME}`);
  }

  // Начисляем очки за все периоды
  const periods = ["WEEKLY", "MONTHLY", "ALL_TIME"] as const;
  for (const period of periods) {
    await prisma.organizerRating.upsert({
      where: {
        guildId_userId_period: {
          guildId: event.guildId,
          userId,
          period,
        },
      },
      create: {
        guildId: event.guildId,
        userId,
        period,
        points,
        eventsCompleted: 0,
        reportsOnTime: event.reportDueAt && report.createdAt <= event.reportDueAt ? 1 : 0,
        reportsLate: event.reportDueAt && report.createdAt > event.reportDueAt ? 1 : 0,
      },
      update: {
        points: { increment: points },
        reportsOnTime: {
          increment: event.reportDueAt && report.createdAt <= event.reportDueAt ? 1 : 0,
        },
        reportsLate: {
          increment: event.reportDueAt && report.createdAt > event.reportDueAt ? 1 : 0,
        },
      },
    });
  }

  // Уведомляем организатора
  await notifyUser(client, userId, baseEmbed("⭐ Начислены очки за отчёт")
    .setColor(COLORS.BRAND)
    .setDescription(
      `**МП:** ${event.title} (${event.code})\n` +
      `**Начислено:** +${points} очков\n\n` +
      breakdown.map((b) => `• ${b}`).join("\n")
    ));

  // Аудит
  await writeAudit(client, {
    guildId: event.guildId,
    action: "RATING_REPORT_POINTS",
    actorId: userId,
    targetType: "event",
    targetId: event.code,
    newValue: `+${points} очков за отчёт`,
  });

  logger.info(`Начислено ${points} очков за отчёт по ${event.code}`);
}

// ─────────────────────────── Получение рейтинга ───────────────────────────

export interface RatingEntry {
  userId: string;
  points: number;
  eventsCompleted: number;
  reportsOnTime: number;
  reportsLate: number;
  rank: number;
}

/**
 * Получает топ организаторов за период.
 */
export async function getTopOrganizers(
  guildId: string,
  period: "WEEKLY" | "MONTHLY" | "ALL_TIME",
  limit = 10
): Promise<RatingEntry[]> {
  const ratings = await prisma.organizerRating.findMany({
    where: { guildId, period },
    orderBy: { points: "desc" },
    take: limit,
  });

  return ratings.map((r, index) => ({
    userId: r.userId,
    points: r.points,
    eventsCompleted: r.eventsCompleted,
    reportsOnTime: r.reportsOnTime,
    reportsLate: r.reportsLate,
    rank: index + 1,
  }));
}

/**
 * Получает рейтинг конкретного пользователя.
 */
export async function getUserRating(
  guildId: string,
  userId: string,
  period: "WEEKLY" | "MONTHLY" | "ALL_TIME" = "ALL_TIME"
): Promise<RatingEntry | null> {
  const rating = await prisma.organizerRating.findUnique({
    where: {
      guildId_userId_period: { guildId, userId, period },
    },
  });

  if (!rating) return null;

  // Вычисляем место в рейтинге
  const allRatings = await prisma.organizerRating.findMany({
    where: { guildId, period },
    orderBy: { points: "desc" },
    select: { userId: true },
  });

  const rank = allRatings.findIndex((r) => r.userId === userId) + 1;

  return {
    userId: rating.userId,
    points: rating.points,
    eventsCompleted: rating.eventsCompleted,
    reportsOnTime: rating.reportsOnTime,
    reportsLate: rating.reportsLate,
    rank,
  };
}

// ─────────────────────────── Значки за рейтинг ───────────────────────────

export interface RatingBadge {
  code: string;
  title: string;
  description: string;
  emoji: string;
  threshold: number;
}

export const RATING_BADGES: RatingBadge[] = [
  { code: "RATING_100", title: "Начинающий организатор", description: "Набрать 100 очков рейтинга", emoji: "🥉", threshold: 100 },
  { code: "RATING_500", title: "Опытный организатор", description: "Набрать 500 очков рейтинга", emoji: "🥈", threshold: 500 },
  { code: "RATING_1000", title: "Мастер МП", description: "Набрать 1000 очков рейтинга", emoji: "🥇", threshold: 1000 },
  { code: "RATING_5000", title: "Легенда МП", description: "Набрать 5000 очков рейтинга", emoji: "💎", threshold: 5000 },
];

/**
 * Проверяет и выдаёт значки за рейтинг.
 */
export async function checkRatingBadges(
  client: Client,
  guildId: string,
  userId: string
): Promise<RatingBadge[]> {
  const rating = await getUserRating(guildId, userId, "ALL_TIME");
  if (!rating) return [];

  const newBadges: RatingBadge[] = [];

  for (const badge of RATING_BADGES) {
    if (rating.points >= badge.threshold) {
      // Проверяем, есть ли уже значок
      const existing = await prisma.userAchievement.findFirst({
        where: {
          userId,
          achievement: { code: badge.code },
        },
      });

      if (!existing) {
        // Создаём достижение, если его нет
        const achievement = await prisma.achievement.upsert({
          where: { code: badge.code },
          create: {
            code: badge.code,
            title: badge.title,
            description: badge.description,
            emoji: badge.emoji,
            metric: "RATING_POINTS",
            threshold: badge.threshold,
          },
          update: {},
        });

        await prisma.userAchievement.create({
          data: { userId, achievementId: achievement.id },
        });

        newBadges.push(badge);

        // Уведомляем пользователя
        await notifyUser(client, userId, baseEmbed(`${badge.emoji} Новое достижение!`)
          .setColor(COLORS.BRAND)
          .setDescription(
            `**${badge.title}**\n${badge.description}\n\n` +
            `Ваш рейтинг: ${rating.points} очков`
          ));
      }
    }
  }

  return newBadges;
}

// ─────────────────────────── Embed для рейтинга ───────────────────────────

/**
 * Создаёт embed с топом организаторов.
 */
export function buildRatingEmbed(
  entries: RatingEntry[],
  period: string,
  guildName: string
): ReturnType<typeof baseEmbed> {
  const periodLabel = {
    WEEKLY: "за неделю",
    MONTHLY: "за месяц",
    ALL_TIME: "за всё время",
  }[period] ?? period;

  const embed = baseEmbed(`🏆 Рейтинг организаторов ${periodLabel}`)
    .setColor(COLORS.BRAND)
    .setDescription(
      entries.length === 0
        ? "Пока нет данных о рейтинге."
        : entries
            .map((e) => {
              const medal = e.rank === 1 ? "🥇" : e.rank === 2 ? "🥈" : e.rank === 3 ? "🥉" : `**${e.rank}.**`;
              return `${medal} <@${e.userId}> — **${e.points}** очков (${e.eventsCompleted} МП)`;
            })
            .join("\n")
    );

  embed.setFooter({ text: `Сервер: ${guildName} • Обновляется автоматически` });
  return withFooter(embed);
}
