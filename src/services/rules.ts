/// Чистые бизнес-правила системы: допустимость переходов статусов,
/// валидация заявок, подсчёт тестов, периоды статистики.
/// Модуль не зависит от Discord и Prisma — здесь лежит логика,
/// которую тестируют unit-тесты и используют команды/сервисы.

import { STATUS, type EventStatus } from "../constants";
import { UserError } from "../lib/errors";

// ─────────────────────────── Переходы статусов ───────────────────────────

/// Разрешённые переходы. Произвольная смена статуса запрещена:
/// любое действие должно пройти через canTransition/assertTransition.
export const TRANSITIONS: Record<EventStatus, readonly EventStatus[]> = {
  DRAFT: [STATUS.PENDING, STATUS.CANCELLED],
  PENDING: [STATUS.APPROVED, STATUS.REVISION, STATUS.REJECTED, STATUS.CANCELLED],
  REVISION: [STATUS.PENDING, STATUS.REJECTED, STATUS.CANCELLED],
  APPROVED: [STATUS.PLANNED, STATUS.ACTIVE, STATUS.CANCELLED],
  PLANNED: [STATUS.ACTIVE, STATUS.CANCELLED],
  ACTIVE: [STATUS.COMPLETED, STATUS.CANCELLED],
  COMPLETED: [STATUS.REPORTED],
  REPORTED: [STATUS.ARCHIVED],
  ARCHIVED: [],
  REJECTED: [],
  CANCELLED: [],
};

export function isEventStatus(value: string): value is EventStatus {
  return Object.prototype.hasOwnProperty.call(TRANSITIONS, value);
}

export function canTransition(from: string, to: string): boolean {
  if (!isEventStatus(from) || !isEventStatus(to)) return false;
  return TRANSITIONS[from].includes(to);
}

/// Бросает UserError с понятным сообщением, если переход недопустим.
export function assertTransition(from: string, to: string): void {
  if (!isEventStatus(from)) throw new UserError(`Неизвестный текущий статус «${from}».`);
  if (!isEventStatus(to)) throw new UserError(`Неизвестный целевой статус «${to}».`);
  if (!canTransition(from, to)) {
    throw new UserError(
      `Переход «${from}» → «${to}» недопустим. Допустимые варианты: ${
        TRANSITIONS[from].length > 0 ? TRANSITIONS[from].join(", ") : "нет (финальный статус)"
      }.`
    );
  }
}

/// Статусы, из которых разрешено редактирование полей заявки.
export const EDITABLE_STATUSES: string[] = [
  STATUS.DRAFT,
  STATUS.PENDING,
  STATUS.REVISION,
  STATUS.APPROVED,
  STATUS.PLANNED,
];

/// Статусы, считающиеся завершёнными (для статистики и ачивок).
export const DONE_STATUSES: string[] = [STATUS.COMPLETED, STATUS.REPORTED, STATUS.ARCHIVED];

/// Статусы, в которых мероприятие «идёт» (для бордов и планировщика).
export const RUNNING_STATUSES: string[] = [STATUS.APPROVED, STATUS.PLANNED, STATUS.ACTIVE];

// ─────────────────────────── Валидация заявки ───────────────────────────

export interface ApplicationFieldInput {
  title: string;
  description: string;
  dateStr: string;
  timeStr: string;
  durationMinutes: number;
  participantsPlanned: number;
  location?: string;
  rules?: string;
  extraInfo?: string;
}

const MAX_TITLE = 100;
const MAX_DESCRIPTION = 1500;
const MAX_DURATION_MINUTES = 1440;
const MAX_PARTICIPANTS = 10000;

/// Возвращает очищенные значения или бросает UserError с причиной.
export function validateApplicationInput(input: ApplicationFieldInput): ApplicationFieldInput {
  const title = input.title.trim();
  const description = input.description.trim();

  if (title.length < 3) throw new UserError("Название МП слишком короткое (минимум 3 символа).");
  if (title.length > MAX_TITLE) throw new UserError(`Название МП длиннее ${MAX_TITLE} символов.`);
  if (description.length < 10) throw new UserError("Описание слишком короткое (минимум 10 символов).");
  if (description.length > MAX_DESCRIPTION) throw new UserError(`Описание длиннее ${MAX_DESCRIPTION} символов.`);

  if (!Number.isFinite(input.durationMinutes) || input.durationMinutes <= 0) {
    throw new UserError("Продолжительность должна быть положительным числом минут.");
  }
  if (input.durationMinutes > MAX_DURATION_MINUTES) {
    throw new UserError(`Продолжительность не может превышать ${MAX_DURATION_MINUTES} минут.`);
  }
  if (!Number.isFinite(input.participantsPlanned) || input.participantsPlanned <= 0) {
    throw new UserError("Количество участников должно быть положительным числом.");
  }
  if (input.participantsPlanned > MAX_PARTICIPANTS) {
    throw new UserError(`Количество участников не может превышать ${MAX_PARTICIPANTS}.`);
  }

  return {
    ...input,
    title,
    description,
    rules: input.rules?.trim() || undefined,
    location: input.location?.trim() || undefined,
    extraInfo: input.extraInfo?.trim() || undefined,
  };
}

/// Проверяет, что дата проведения не в прошлом (с допуском 1 минута).
export function assertFutureDate(scheduledAt: Date, now: Date = new Date()): void {
  if (Number.isNaN(scheduledAt.getTime())) throw new UserError("Некорректная дата проведения.");
  if (scheduledAt.getTime() < now.getTime() - 60_000) {
    throw new UserError("Дата и время проведения уже прошли. Укажите будущую дату.");
  }
}

// ─────────────────────────── Конфликты расписания ───────────────────────────

/// Занятое окно в расписании (существующее МП).
export interface ScheduleSlot {
  id: number;
  code: string;
  title: string;
  scheduledAt: Date;
  durationMinutes: number;
  organizerId?: string | null;
}

/// Кандидат на планирование (создание или редактирование даты).
export interface CandidateSlot {
  scheduledAt: Date;
  durationMinutes: number;
  /// ID исключаемого мероприятия (при редактировании самого себя).
  excludeId?: number;
}

/// Пересечение интервалов: касание границами (одно заканчивается,
/// когда начинается другое) конфликтом не считается.
export function intervalsOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/// Находит мероприятия, чьё время проведения пересекается с кандидатом.
/// Результат отсортирован по времени начала.
export function findScheduleConflicts(
  slots: readonly ScheduleSlot[],
  candidate: CandidateSlot
): ScheduleSlot[] {
  const start = candidate.scheduledAt.getTime();
  const end = start + Math.max(1, candidate.durationMinutes) * 60_000;
  return slots
    .filter((slot) => {
      if (candidate.excludeId !== undefined && slot.id === candidate.excludeId) return false;
      const sStart = slot.scheduledAt.getTime();
      const sEnd = sStart + Math.max(1, slot.durationMinutes) * 60_000;
      return intervalsOverlap(start, end, sStart, sEnd);
    })
    .sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());
}

/// Человекочитаемое описание конфликтов для сообщения об ошибке.
export function describeConflicts(conflicts: readonly ScheduleSlot[]): string {
  const pad = (d: Date): string => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const lines = conflicts.map((c) => {
    const end = new Date(c.scheduledAt.getTime() + Math.max(1, c.durationMinutes) * 60_000);
    const who = c.organizerId ? ` — <@${c.organizerId}>` : "";
    return `• \`${c.code}\` «${c.title}» — ${pad(c.scheduledAt)}–${pad(end)}${who}`;
  });
  return (
    `В это время уже запланировано МП:\n${lines.join("\n")}\n` +
    `Выберите другое время или перенесите конфликтное мероприятие.`
  );
}

// ─────────────────────────── Подсчёт тестов ───────────────────────────

export interface ScoreableQuestion {
  id: number;
  correctIndex: number;
}

export interface ScoreResult {
  correct: number;
  total: number;
  score: number;
  passed: boolean;
}

/// Считает результат попытки. answers[i] — индекс выбранного варианта
/// для questionIds[i]; отсутствие ответа (undefined) засчитывается как ошибка.
export function computeTestScore(
  questions: readonly ScoreableQuestion[],
  answers: readonly (number | undefined)[],
  passScore: number
): ScoreResult {
  const total = questions.length;
  let correct = 0;
  questions.forEach((q, i) => {
    if (answers[i] !== undefined && answers[i] === q.correctIndex) correct++;
  });
  const score = total > 0 ? Math.round((correct / total) * 100) : 0;
  return { correct, total, score, passed: score >= passScore };
}

// ─────────────────────────── Периоды статистики ───────────────────────────

export type StatsPeriod = "today" | "week" | "month" | "year" | "all";

export const STATS_PERIOD_RU: Record<StatsPeriod, string> = {
  today: "сегодня",
  week: "неделя",
  month: "месяц",
  year: "год",
  all: "всё время",
};

/// Границы периода статистики. Для «all» from = null (без фильтра).
export function periodRange(period: StatsPeriod, now: Date = new Date()): { from: Date | null; label: string } {
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  switch (period) {
    case "today":
      return { from: startOfDay, label: STATS_PERIOD_RU.today };
    case "week":
      return { from: new Date(startOfDay.getTime() - 6 * 24 * 3600_000), label: STATS_PERIOD_RU.week };
    case "month":
      return { from: new Date(startOfDay.getTime() - 29 * 24 * 3600_000), label: STATS_PERIOD_RU.month };
    case "year":
      return { from: new Date(startOfDay.getTime() - 364 * 24 * 3600_000), label: STATS_PERIOD_RU.year };
    case "all":
    default:
      return { from: null, label: STATS_PERIOD_RU.all };
  }
}

// ─────────────────────────── Отчёт ───────────────────────────

export interface ReportFieldInput {
  participantsActual: number;
  durationActualMinutes: number;
  result: string;
}

export function validateReportInput(input: ReportFieldInput): void {
  if (!Number.isInteger(input.participantsActual) || input.participantsActual < 0) {
    throw new UserError("Количество участников указывается целым неотрицательным числом.");
  }
  if (!Number.isInteger(input.durationActualMinutes) || input.durationActualMinutes <= 0) {
    throw new UserError("Продолжительность указывается положительным целым числом минут.");
  }
  if (input.result.trim().length < 3) throw new UserError("Опишите результат мероприятия (минимум 3 символа).");
}
