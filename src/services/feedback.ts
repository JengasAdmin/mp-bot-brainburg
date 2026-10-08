import { prisma } from "../lib/db";
import { UserError } from "../lib/errors";

/// Оценки МП участниками (1–5 звёзд). Статусы, в которых приём открыт
/// после завершения: COMPLETED / REPORTED / ARCHIVED.
const RATEABLE = ["COMPLETED", "REPORTED", "ARCHIVED"];

export interface FeedbackStats {
  count: number;
  average: number;
  /// Количество оценок по каждой звезде (индекс 0 → 1 звезда).
  distribution: number[];
  /// Оценка конкретного пользователя (если голосовал).
  myScore: number | null;
}

export function assertRateable(status: string): void {
  if (!RATEABLE.includes(status)) {
    throw new UserError("Оценить мероприятие можно после его завершения.");
  }
}

/// Сохраняет/обновляет оценку пользователя (повторное голосование перезаписывает).
export async function submitFeedback(eventId: number, userId: string, score: number, comment?: string | null): Promise<void> {
  if (!Number.isInteger(score) || score < 1 || score > 5) {
    throw new UserError("Оценка должна быть от 1 до 5.");
  }
  await prisma.eventFeedback.upsert({
    where: { eventId_userId: { eventId, userId } },
    create: { eventId, userId, score, comment: comment ?? null },
    update: { score, comment: comment ?? null },
  });
}

export async function getFeedbackStats(eventId: number, userId?: string): Promise<FeedbackStats> {
  const rows = await prisma.eventFeedback.findMany({ where: { eventId } });
  const distribution = [0, 0, 0, 0, 0];
  let sum = 0;
  for (const r of rows) {
    sum += r.score;
    distribution[r.score - 1] += 1;
  }
  const mine = userId ? rows.find((r) => r.userId === userId) : undefined;
  return {
    count: rows.length,
    average: rows.length > 0 ? Math.round((sum / rows.length) * 10) / 10 : 0,
    distribution,
    myScore: mine?.score ?? null,
  };
}

/// Текстовое представление распределения оценок.
export function formatDistribution(stats: FeedbackStats): string {
  if (stats.count === 0) return "Оценок пока нет.";
  return stats.distribution
    .map((count, i) => {
      const stars = "⭐".repeat(i + 1);
      const bar = count > 0 ? "█".repeat(Math.min(10, count)) : "";
      return `${stars} — ${count} ${bar}`;
    })
    .join("\n");
}
