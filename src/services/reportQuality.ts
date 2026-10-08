import type { Client } from "discord.js";
import type { Event, EventReport } from "@prisma/client";
import { prisma } from "../lib/db";
import { logger } from "../lib/logger";
import { notifyUser } from "./notifications";
import { statusEmbed } from "../lib/embeds";
import { STATUS } from "../constants";
import { formatDateTime } from "../lib/time";

// ─────────────────────────── Проверка качества отчёта ───────────────────────────

export interface ReportQualityResult {
  isValid: boolean;
  missingFields: string[];
  warnings: string[];
}

/**
 * Проверяет качество отчёта.
 * Обязательные поля: описание (result), статистика (participantsActual, durationActualMinutes).
 * Рекомендуемые: проблемы, комментарий, предложения.
 */
export function checkReportQuality(report: EventReport): ReportQualityResult {
  const missingFields: string[] = [];
  const warnings: string[] = [];

  // Обязательные поля
  if (!report.result || report.result.trim().length < 10) {
    missingFields.push("Описание результата (минимум 10 символов)");
  }

  if (report.participantsActual <= 0) {
    missingFields.push("Количество участников (факт)");
  }

  if (report.durationActualMinutes <= 0) {
    missingFields.push("Продолжительность (факт)");
  }

  // Рекомендуемые поля
  if (!report.problems || report.problems.trim().length < 5) {
    warnings.push("Рекомендуется указать проблемы, возникшие во время МП");
  }

  if (!report.comment || report.comment.trim().length < 10) {
    warnings.push("Рекомендуется добавить комментарий организатора");
  }

  if (!report.suggestions || report.suggestions.trim().length < 5) {
    warnings.push("Рекомендуется добавить предложения по улучшению");
  }

  return {
    isValid: missingFields.length === 0,
    missingFields,
    warnings,
  };
}

/**
 * Проверяет отчёт и отправляет уведомление о недостающих элементах.
 */
export async function validateAndNotifyReport(
  client: Client,
  event: Event,
  report: EventReport
): Promise<ReportQualityResult> {
  const result = checkReportQuality(report);

  // Сверка с фактической посещаемостью голосового канала (защита от накрутки).
  try {
    const { getAttendance } = await import("./attendance");
    const attended = (await getAttendance(event.id)).length;
    if (attended > 0) {
      const reported = report.participantsActual;
      if (reported > attended + Math.max(2, Math.round(attended * 0.3))) {
        result.warnings.push(
          `Участников в отчёте (${reported}) заметно больше, чем зафиксировано по голосовому каналу (${attended}) — сверьте данные`
        );
      }
    }
  } catch (err) {
    logger.warn("Не удалось получить сводку посещаемости:", err);
  }

  if (!result.isValid) {
    // Отправляем уведомление о недостающих полях
    await notifyUser(client, event.organizerId ?? event.authorId, statusEmbed(
      "⚠️ Отчёт требует доработки",
      `В отчёте по мероприятию «${event.title}» (${event.code}) отсутствуют обязательные поля:\n\n` +
      result.missingFields.map((f) => `• ${f}`).join("\n") +
      "\n\nПожалуйста, дополните отчёт.",
      STATUS.COMPLETED
    ));
  } else if (result.warnings.length > 0) {
    // Отправляем предупреждение о рекомендуемых полях
    await notifyUser(client, event.organizerId ?? event.authorId, statusEmbed(
      "💡 Рекомендации по улучшению отчёта",
      `Отчёт по мероприятию «${event.title}» (${event.code}) принят, но можно улучшить:\n\n` +
      result.warnings.map((w) => `• ${w}`).join("\n"),
      STATUS.REPORTED
    ));
  }

  return result;
}

/**
 * Проверяет все отчёты, сданные за последние 24 часа, и отправляет напоминания.
 */
export async function checkRecentReportsQuality(
  client: Client,
  guildId: string
): Promise<number> {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const recentReports = await prisma.eventReport.findMany({
    where: {
      createdAt: { gte: yesterday },
    },
    include: { event: true },
  });

  let notified = 0;

  for (const report of recentReports) {
    const result = checkReportQuality(report);
    if (!result.isValid || result.warnings.length > 0) {
      await validateAndNotifyReport(client, report.event, report);
      notified++;
    }
  }

  if (notified > 0) {
    logger.info(`Проверено ${recentReports.length} отчётов, отправлено ${notified} уведомлений`);
  }

  return notified;
}
