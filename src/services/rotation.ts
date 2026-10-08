import { prisma } from "../lib/db";
import { RUNNING_STATUSES, findScheduleConflicts } from "./rules";

/// Ротация организаторов: кто давно не проводил МП и кто свободен
/// в указанное время (для назначения без конфликтов).

export interface RotationRow {
  userId: string;
  username: string;
  nickname: string | null;
  position: string;
  /// Дата последнего проведённого МП (null — ещё не проводил).
  lastEventAt: Date | null;
  lastEventTitle: string | null;
  idleDays: number;
}

const LEADERS = ["HEAD", "SENIOR", "ORGANIZER"];
const DAY_MS = 24 * 3600_000;

/// Сотрудники-организаторы с числом дней с последнего проведённого МП.
/// Сортировка: от самого «прогульщика» (или никогда не проводивших).
/// Список сотрудников глобален (User не привязан к гильдии), события — по guildId.
export async function getRotation(guildId: string, now: Date = new Date()): Promise<RotationRow[]> {
  const staff = await prisma.user.findMany({
    where: { leftAt: null, position: { in: LEADERS } },
    orderBy: { position: "desc" },
  });

  const rows: RotationRow[] = [];
  for (const user of staff) {
    const last = await prisma.event.findFirst({
      where: {
        guildId,
        status: { in: ["ACTIVE", "COMPLETED", "REPORTED", "ARCHIVED"] },
        OR: [
          { organizerId: user.discordId },
          { authorId: user.discordId },
          { staff: { some: { userId: user.discordId, role: "ORGANIZER" } } },
        ],
      },
      orderBy: { scheduledAt: "desc" },
      select: { scheduledAt: true, title: true },
    });
    const lastEventAt = last?.scheduledAt ?? null;
    const idleDays = lastEventAt ? Math.floor((now.getTime() - lastEventAt.getTime()) / DAY_MS) : Number.MAX_SAFE_INTEGER;
    rows.push({
      userId: user.discordId,
      username: user.username,
      nickname: user.nickname,
      position: user.position,
      lastEventAt,
      lastEventTitle: last?.title ?? null,
      idleDays,
    });
  }

  return rows.sort((a, b) => b.idleDays - a.idleDays || a.username.localeCompare(b.username));
}

/// Сотрудники, свободные в указанное окно (нет МП как организатора/автора).
export async function getFreeAt(
  guildId: string,
  scheduledAt: Date,
  durationMinutes: number
): Promise<RotationRow[]> {
  const rotation = await getRotation(guildId);
  if (rotation.length === 0) return [];

  // Все идущие/запланированные МП в окне ±максимальная длительность.
  const DAY = 1440 * 60_000;
  const busy = await prisma.event.findMany({
    where: {
      guildId,
      status: { in: RUNNING_STATUSES },
      scheduledAt: { gt: new Date(scheduledAt.getTime() - DAY), lt: new Date(scheduledAt.getTime() + durationMinutes * 60_000) },
    },
    select: {
      id: true, code: true, title: true, scheduledAt: true, durationMinutes: true,
      organizerId: true, authorId: true,
      staff: { select: { userId: true } },
    },
  });

  const occupied = new Set<string>();
  const conflicts = findScheduleConflicts(busy, { scheduledAt, durationMinutes });
  for (const event of conflicts) {
    const full = busy.find((b) => b.id === event.id);
    if (!full) continue;
    if (full.organizerId) occupied.add(full.organizerId);
    occupied.add(full.authorId);
    for (const s of full.staff) occupied.add(s.userId);
  }

  return rotation.filter((r) => !occupied.has(r.userId));
}
