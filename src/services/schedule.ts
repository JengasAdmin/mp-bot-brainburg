import { prisma } from "../lib/db";
import { UserError } from "../lib/errors";
import { RUNNING_STATUSES, describeConflicts, findScheduleConflicts, type ScheduleSlot } from "./rules";

/// Проверка расписания от двойных броней: в окно проведения не должно
/// попадать другое МП в статусах APPROVED/PLANNED/ACTIVE.
/// Вызывается при создании заявки и редактировании даты.

const MAX_DURATION_MS = 1440 * 60_000; // допустимая продолжительность МП

export async function findConflicts(
  guildId: string,
  scheduledAt: Date,
  durationMinutes: number,
  excludeId?: number
): Promise<ScheduleSlot[]> {
  const start = scheduledAt.getTime();
  const end = start + Math.max(1, durationMinutes) * 60_000;

  // Грубый предфильтр по окну ±максимальная длительность, точная проверка — в rules.
  const rows = await prisma.event.findMany({
    where: {
      guildId,
      status: { in: RUNNING_STATUSES },
      scheduledAt: {
        gt: new Date(start - MAX_DURATION_MS),
        lt: new Date(end),
      },
      ...(excludeId !== undefined ? { id: { not: excludeId } } : {}),
    },
    select: {
      id: true,
      code: true,
      title: true,
      scheduledAt: true,
      durationMinutes: true,
      organizerId: true,
    },
  });

  return findScheduleConflicts(rows, { scheduledAt, durationMinutes, excludeId });
}

/// Бросает UserError с перечислением конфликтов, если окно уже занято.
export async function assertNoScheduleConflict(
  guildId: string,
  scheduledAt: Date,
  durationMinutes: number,
  excludeId?: number
): Promise<void> {
  const conflicts = await findConflicts(guildId, scheduledAt, durationMinutes, excludeId);
  if (conflicts.length > 0) {
    throw new UserError(describeConflicts(conflicts));
  }
}
