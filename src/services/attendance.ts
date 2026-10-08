import type { VoiceState } from "discord.js";
import { prisma } from "../lib/db";
import { logger } from "../lib/logger";
import { STATUS } from "../constants";

/// Учёт посещаемости МП по голосовому каналу: бот слушает voiceStateUpdate,
/// фиксирует сессии (кто, когда вошёл/вышел) и считает минуты участия.

export interface AttendanceRow {
  userId: string;
  minutes: number;
  sessions: number;
}

async function findEventByVoiceChannel(channelId: string, activeOnly: boolean) {
  return prisma.event.findFirst({
    where: { voiceChannelId: channelId, ...(activeOnly ? { status: STATUS.ACTIVE } : {}) },
    select: { id: true, code: true },
  });
}

/// Закрывает незакрытую сессию пользователя в мероприятии.
async function closeOpenSession(eventId: number, userId: string): Promise<void> {
  const open = await prisma.voiceSession.findFirst({
    where: { eventId, userId, leftAt: null },
    orderBy: { joinedAt: "desc" },
  });
  if (!open) return;
  const minutes = Math.max(1, Math.round((Date.now() - open.joinedAt.getTime()) / 60_000));
  await prisma.voiceSession.update({ where: { id: open.id }, data: { leftAt: new Date(), minutes } });
}

/// Обработчик voiceStateUpdate: вход/выход/переход между каналами.
export async function handleVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): Promise<void> {
  try {
    const member = newState.member ?? oldState.member;
    if (!member || member.user.bot) return;

    const from = oldState.channelId;
    const to = newState.channelId;
    if (from === to) return;

    // Выход из голосового канала МП (в т.ч. переход в другой канал).
    if (from) {
      const leftEvent = await findEventByVoiceChannel(from, false);
      if (leftEvent) await closeOpenSession(leftEvent.id, member.id);
    }

    // Вход в голосовой канал активного МП.
    if (to) {
      const joinedEvent = await findEventByVoiceChannel(to, true);
      if (joinedEvent) {
        await closeOpenSession(joinedEvent.id, member.id); // страховка от незакрытых сессий
        await prisma.voiceSession.create({ data: { eventId: joinedEvent.id, userId: member.id } });
      }
    }
  } catch (err) {
    logger.warn("Ошибка учёта голосового участия:", err);
  }
}

/// Закрывает все открытые сессии мероприятия (вызывается при завершении/отмене).
export async function closeAllSessions(eventId: number): Promise<void> {
  const open = await prisma.voiceSession.findMany({ where: { eventId, leftAt: null } });
  for (const session of open) {
    const minutes = Math.max(1, Math.round((Date.now() - session.joinedAt.getTime()) / 60_000));
    await prisma.voiceSession.update({ where: { id: session.id }, data: { leftAt: new Date(), minutes } });
  }
}

/// Сводка посещаемости: минуты на человека (открытые сессии считаются «до сейчас»).
export async function getAttendance(eventId: number): Promise<AttendanceRow[]> {
  const sessions = await prisma.voiceSession.findMany({ where: { eventId } });
  const now = Date.now();
  const byUser = new Map<string, { minutes: number; sessions: number }>();
  for (const s of sessions) {
    const effective = s.leftAt
      ? s.minutes
      : Math.max(0, Math.round((now - s.joinedAt.getTime()) / 60_000));
    const row = byUser.get(s.userId) ?? { minutes: 0, sessions: 0 };
    row.minutes += effective;
    row.sessions += 1;
    byUser.set(s.userId, row);
  }
  return [...byUser.entries()]
    .map(([userId, row]) => ({ userId, ...row }))
    .sort((a, b) => b.minutes - a.minutes);
}

/// Строка-сводка для отчёта/сообщений (или null, если данных нет).
export function formatAttendance(rows: readonly AttendanceRow[]): string | null {
  if (rows.length === 0) return null;
  const total = rows.reduce((sum, r) => sum + r.minutes, 0);
  const top = rows.slice(0, 15);
  const lines = top.map((r) => `<@${r.userId}> — ${r.minutes} мин`);
  const more = rows.length > top.length ? `\n…и ещё ${rows.length - top.length} чел.` : "";
  return `🎙 Участие в голосовом канале: **${rows.length} чел.**, суммарно **${total} мин**\n${lines.join("\n")}${more}`;
}
