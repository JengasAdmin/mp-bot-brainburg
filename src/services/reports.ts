import { type Client, type Snowflake, type User } from "discord.js";
import { prisma } from "../lib/db";
import { UserError } from "../lib/errors";
import { statusEmbed } from "../lib/embeds";
import { STATUS } from "../constants";
import { applyTransition, loadEvent, refreshEventViews } from "./events";
import { validateReportInput } from "./rules";
import { evaluateAchievements } from "./achievements";
import { notifyUser } from "./notifications";
import { awardReportPoints, checkRatingBadges } from "./rating";
import { validateAndNotifyReport } from "./reportQuality";

export interface ReportInput {
  participantsActual: number;
  durationActualMinutes: number;
  result: string;
  problems?: string;
  comment?: string;
  suggestions?: string;
  materials?: string;
}

export async function createReport(
  client: Client,
  eventId: number,
  author: User,
  input: ReportInput
): Promise<void> {
  const event = await loadEvent(eventId);
  if (event.status !== STATUS.COMPLETED) {
    throw new UserError("Отчёт можно создать только для завершённого МП.");
  }
  if (event.report) throw new UserError(`Отчёт по ${event.code} уже сдан.`);
  validateReportInput(input);

  await prisma.eventReport.create({
    data: {
      eventId: event.id,
      participantsActual: input.participantsActual,
      durationActualMinutes: input.durationActualMinutes,
      result: input.result,
      problems: input.problems,
      comment: input.comment,
      suggestions: input.suggestions,
      materials: input.materials,
      createdById: author.id,
    },
  });

  try {
    await applyTransition(client, event, STATUS.REPORTED, {
      expectedFrom: [STATUS.COMPLETED],
      actorId: author.id,
      actorTag: author.tag,
      data: { reportedAt: new Date(), reportDueAt: null },
    });
  } catch (err) {
    // Отчёт уже создан — откатываем запись, чтобы не осталось сироты.
    await prisma.eventReport.delete({ where: { eventId: event.id } }).catch(() => undefined);
    throw err;
  }

  await notifyUser(client, event.authorId,
    statusEmbed(`📋 Отчёт по ${event.code} сдан`, `Мероприятие «${event.title}» — отчёт принят. Ожидает архивирования.`, STATUS.REPORTED));

  const fresh = await loadEvent(event.id);
  await refreshEventViews(client, fresh);
  await evaluateAchievements(client, event.guildId, author.id);

  // Начисляем очки рейтинга за отчёт
  const report = await prisma.eventReport.findUnique({ where: { eventId: event.id } });
  if (report) {
    await awardReportPoints(client, fresh, report);
    await checkRatingBadges(client, event.guildId, author.id);

    // Проверяем качество отчёта
    await validateAndNotifyReport(client, fresh, report);
  }
}
