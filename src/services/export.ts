import type { Client } from "discord.js";
import { prisma } from "../lib/db";
import { logger } from "../lib/logger";
import { writeAudit } from "./audit";
import { baseEmbed, withFooter } from "../lib/embeds";
import { COLORS } from "../constants";
import { formatDateTime } from "../lib/time";

// ─────────────────────────── Экспорт в CSV ───────────────────────────

/**
 * Экспортирует статистику в CSV.
 */
export async function exportStatsToCSV(
  guildId: string,
  period: "today" | "week" | "month" | "year" | "all"
): Promise<string> {
  const now = new Date();
  let startDate: Date;

  switch (period) {
    case "today":
      startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      break;
    case "week":
      startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      break;
    case "month":
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      break;
    case "year":
      startDate = new Date(now.getFullYear(), 0, 1);
      break;
    default:
      startDate = new Date(0);
  }

  const events = await prisma.event.findMany({
    where: {
      guildId,
      createdAt: { gte: startDate },
    },
    include: { category: true, report: true },
    orderBy: { createdAt: "asc" },
  });

  // Формируем CSV
  const headers = [
    "Код",
    "Название",
    "Категория",
    "Статус",
    "Дата",
    "Организатор",
    "Участники (план)",
    "Участники (факт)",
    "Отчёт",
  ];

  const rows = events.map((e) => [
    e.code,
    e.title,
    e.category?.name ?? "",
    e.status,
    formatDateTime(e.scheduledAt),
    e.organizerId ?? e.authorId,
    String(e.participantsPlanned),
    String(e.report?.participantsActual ?? ""),
    e.report ? "Да" : "Нет",
  ]);

  const csv = [headers, ...rows]
    .map((row) => row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(","))
    .join("\n");

  return csv;
}

// ─────────────────────────── Экспорт в PDF ───────────────────────────

/**
 * Экспортирует статистику в PDF (текстовый формат).
 */
export async function exportStatsToPDF(
  guildId: string,
  period: "today" | "week" | "month" | "year" | "all"
): Promise<string> {
  const now = new Date();
  let startDate: Date;

  switch (period) {
    case "today":
      startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      break;
    case "week":
      startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      break;
    case "month":
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      break;
    case "year":
      startDate = new Date(now.getFullYear(), 0, 1);
      break;
    default:
      startDate = new Date(0);
  }

  const events = await prisma.event.findMany({
    where: {
      guildId,
      createdAt: { gte: startDate },
    },
    include: { category: true, report: true },
    orderBy: { createdAt: "asc" },
  });

  // Формируем текстовый отчёт
  const lines: string[] = [];
  lines.push("=".repeat(60));
  lines.push("ОТЧЁТ ОТДЕЛА ОРГАНИЗАТОРОВ МП");
  lines.push("=".repeat(60));
  lines.push("");
  lines.push(`Период: ${period}`);
  lines.push(`Дата формирования: ${formatDateTime(now)}`);
  lines.push(`Всего мероприятий: ${events.length}`);
  lines.push("");

  // Статистика по статусам
  const statusCounts: Record<string, number> = {};
  for (const e of events) {
    statusCounts[e.status] = (statusCounts[e.status] ?? 0) + 1;
  }
  lines.push("СТАТИСТИКА ПО СТАТУСАМ:");
  lines.push("-".repeat(40));
  for (const [status, count] of Object.entries(statusCounts)) {
    lines.push(`  ${status}: ${count}`);
  }
  lines.push("");

  // Статистика по категориям
  const categoryCounts: Record<string, number> = {};
  for (const e of events) {
    const cat = e.category?.name ?? "Без категории";
    categoryCounts[cat] = (categoryCounts[cat] ?? 0) + 1;
  }
  lines.push("СТАТИСТИКА ПО КАТЕГОРИЯМ:");
  lines.push("-".repeat(40));
  for (const [cat, count] of Object.entries(categoryCounts)) {
    lines.push(`  ${cat}: ${count}`);
  }
  lines.push("");

  // Список мероприятий
  lines.push("СПИСОК МЕРОПРИЯТИЙ:");
  lines.push("-".repeat(40));
  for (const e of events) {
    lines.push(`  ${e.code} — ${e.title}`);
    lines.push(`    Категория: ${e.category?.name ?? "—"}`);
    lines.push(`    Статус: ${e.status}`);
    lines.push(`    Дата: ${formatDateTime(e.scheduledAt)}`);
    lines.push(`    Организатор: ${e.organizerId ?? e.authorId}`);
    lines.push(`    Участники: ${e.report?.participantsActual ?? e.participantsPlanned} (план: ${e.participantsPlanned})`);
    lines.push(`    Отчёт: ${e.report ? "сдан" : "не сдан"}`);
    lines.push("");
  }

  lines.push("=".repeat(60));
  lines.push("Конец отчёта");

  return lines.join("\n");
}

// ─────────────────────────── Автоматические отчёты ───────────────────────────

/**
 * Генерирует еженедельный отчёт.
 */
export async function generateWeeklyReport(
  client: Client,
  guildId: string
): Promise<string> {
  const csv = await exportStatsToCSV(guildId, "week");
  const pdf = await exportStatsToPDF(guildId, "week");

  // Сохраняем аудит
  await writeAudit(client, {
    guildId,
    action: "WEEKLY_REPORT_GENERATED",
    targetType: "report",
    newValue: "Еженедельный отчёт",
  });

  logger.info(`Сгенерирован еженедельный отчёт для сервера ${guildId}`);
  return pdf;
}

/**
 * Генерирует ежемесячный отчёт.
 */
export async function generateMonthlyReport(
  client: Client,
  guildId: string
): Promise<string> {
  const csv = await exportStatsToCSV(guildId, "month");
  const pdf = await exportStatsToPDF(guildId, "month");

  // Сохраняем аудит
  await writeAudit(client, {
    guildId,
    action: "MONTHLY_REPORT_GENERATED",
    targetType: "report",
    newValue: "Ежемесячный отчёт",
  });

  logger.info(`Сгенерирован ежемесячный отчёт для сервера ${guildId}`);
  return pdf;
}
