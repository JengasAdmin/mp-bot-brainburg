import { describe, expect, it } from "vitest";
import { STATUS } from "../src/constants";
import { UserError } from "../src/lib/errors";
import {
  DONE_STATUSES,
  EDITABLE_STATUSES,
  RUNNING_STATUSES,
  TRANSITIONS,
  assertFutureDate,
  assertTransition,
  canTransition,
  computeTestScore,
  describeConflicts,
  findScheduleConflicts,
  intervalsOverlap,
  isEventStatus,
  periodRange,
  validateApplicationInput,
  validateReportInput,
} from "../src/services/rules";

describe("переходы статусов", () => {
  it("разрешает только переходы из таблицы TRANSITIONS", () => {
    expect(canTransition(STATUS.PENDING, STATUS.APPROVED)).toBe(true);
    expect(canTransition(STATUS.PENDING, STATUS.REVISION)).toBe(true);
    expect(canTransition(STATUS.ACTIVE, STATUS.COMPLETED)).toBe(true);
    expect(canTransition(STATUS.COMPLETED, STATUS.REPORTED)).toBe(true);
    expect(canTransition(STATUS.REPORTED, STATUS.ARCHIVED)).toBe(true);
  });

  it("запрещает обратные и произвольные переходы", () => {
    expect(canTransition(STATUS.APPROVED, STATUS.PENDING)).toBe(false);
    expect(canTransition(STATUS.ARCHIVED, STATUS.ACTIVE)).toBe(false);
    expect(canTransition(STATUS.REJECTED, STATUS.PENDING)).toBe(false);
    expect(canTransition(STATUS.ACTIVE, STATUS.ARCHIVED)).toBe(false);
  });

  it("запрещает переходы из/в неизвестные статусы", () => {
    expect(canTransition("UNKNOWN", STATUS.PENDING)).toBe(false);
    expect(canTransition(STATUS.PENDING, "UNKNOWN")).toBe(false);
    expect(isEventStatus("UNKNOWN")).toBe(false);
    expect(isEventStatus(STATUS.PLANNED)).toBe(true);
  });

  it("финальные статусы не имеют исходящих переходов", () => {
    for (const status of [STATUS.ARCHIVED, STATUS.REJECTED, STATUS.CANCELLED] as const) {
      expect(TRANSITIONS[status]).toHaveLength(0);
      expect(canTransition(status, STATUS.PLANNED)).toBe(false);
    }
  });

  it("assertTransition бросает UserError с перечислением допустимых вариантов", () => {
    expect(() => assertTransition(STATUS.PENDING, STATUS.APPROVED)).not.toThrow();
    expect(() => assertTransition(STATUS.APPROVED, STATUS.PENDING)).toThrowError(UserError);
    try {
      assertTransition(STATUS.APPROVED, STATUS.PENDING);
      expect.unreachable("должен был бросить UserError");
    } catch (err) {
      expect((err as UserError).message).toContain("недопустим");
      expect((err as UserError).message).toContain(STATUS.PLANNED);
    }
    expect(() => assertTransition("NOPE", STATUS.PENDING)).toThrowError(UserError);
  });

  it("наборы статусов для статистики и панелей не пересекаются с финальными ошибками", () => {
    expect(DONE_STATUSES).toContain(STATUS.ARCHIVED);
    expect(RUNNING_STATUSES).toContain(STATUS.ACTIVE);
    expect(EDITABLE_STATUSES).not.toContain(STATUS.COMPLETED);
    expect(EDITABLE_STATUSES).not.toContain(STATUS.ARCHIVED);
  });
});

describe("валидация заявки", () => {
  const valid = {
    title: "Мафия на 20 человек",
    description: "Классическая мафия с голосованиями и раундами.",
    dateStr: "28.09.2026",
    timeStr: "20:00",
    durationMinutes: 60,
    participantsPlanned: 20,
  };

  it("очищает пробелы и возвращает нормализованные данные", () => {
    const out = validateApplicationInput({ ...valid, title: `  ${valid.title}  `, location: "  voice  " });
    expect(out.title).toBe(valid.title);
    expect(out.location).toBe("voice");
  });

  it("отклоняет короткое название и описание", () => {
    expect(() => validateApplicationInput({ ...valid, title: "МП" })).toThrowError(UserError);
    expect(() => validateApplicationInput({ ...valid, description: "коротко" })).toThrowError(UserError);
  });

  it("отклоняет неположительные числа и превышения лимитов", () => {
    expect(() => validateApplicationInput({ ...valid, durationMinutes: 0 })).toThrowError(UserError);
    expect(() => validateApplicationInput({ ...valid, durationMinutes: 1441 })).toThrowError(UserError);
    expect(() => validateApplicationInput({ ...valid, participantsPlanned: -5 })).toThrowError(UserError);
    expect(() => validateApplicationInput({ ...valid, participantsPlanned: 10_001 })).toThrowError(UserError);
  });
});

describe("проверка даты проведения", () => {
  const now = new Date("2026-09-27T12:00:00");

  it("пропускает будущую дату и дату в пределах минутной инерции", () => {
    expect(() => assertFutureDate(new Date("2026-09-28T12:00:00"), now)).not.toThrow();
    expect(() => assertFutureDate(new Date("2026-09-27T11:59:30"), now)).not.toThrow();
  });

  it("отклоняет прошедшую дату и Invalid Date", () => {
    expect(() => assertFutureDate(new Date("2026-09-27T11:00:00"), now)).toThrowError(UserError);
    expect(() => assertFutureDate(new Date("некорректно"), now)).toThrowError(UserError);
  });
});

describe("подсчёт тестов", () => {
  const questions = [
    { id: 1, correctIndex: 0 },
    { id: 2, correctIndex: 2 },
    { id: 3, correctIndex: 1 },
  ];

  it("считает все ответы верными", () => {
    const r = computeTestScore(questions, [0, 2, 1], 70);
    expect(r).toEqual({ correct: 3, total: 3, score: 100, passed: true });
  });

  it("пропуск ответа засчитывается как ошибка", () => {
    const r = computeTestScore(questions, [0, undefined, 1], 70);
    expect(r.correct).toBe(2);
    expect(r.score).toBe(67);
    expect(r.passed).toBe(false);
  });

  it("проходной балл граничный: равенство — сдано", () => {
    const r = computeTestScore(questions, [0, 2, 1], 100);
    expect(r.passed).toBe(true);
    expect(computeTestScore(questions, [0, 0, 1], 67).passed).toBe(true);
  });

  it("пустой тест не падает и не сдаётся", () => {
    const r = computeTestScore([], [], 70);
    expect(r).toEqual({ correct: 0, total: 0, score: 0, passed: false });
  });
});

describe("периоды статистики", () => {
  const now = new Date(2026, 8, 27, 15, 30);

  it("«всё время» — без нижней границы", () => {
    expect(periodRange("all", now).from).toBeNull();
  });

  it("«сегодня» начинается с полуночи текущего дня", () => {
    expect(periodRange("today", now).from).toEqual(new Date(2026, 8, 27, 0, 0, 0, 0));
  });

  it("«неделя» охватывает 7 дней включая сегодня", () => {
    expect(periodRange("week", now).from).toEqual(new Date(2026, 8, 21, 0, 0, 0, 0));
  });

  it("«месяц» и «год» охватывают 30 и 365 дней", () => {
    expect(periodRange("month", now).from).toEqual(new Date(2026, 7, 29, 0, 0, 0, 0));
    expect(periodRange("year", now).from).toEqual(new Date(2025, 8, 28, 0, 0, 0, 0));
  });
});

describe("валидация отчёта", () => {
  it("принимает корректные данные", () => {
    expect(() => validateReportInput({ participantsActual: 18, durationActualMinutes: 55, result: "Проведено успешно" })).not.toThrow();
  });

  it("отклоняет отрицательные и дробные значения", () => {
    expect(() => validateReportInput({ participantsActual: -1, durationActualMinutes: 55, result: "ok результат" })).toThrowError(UserError);
    expect(() => validateReportInput({ participantsActual: 18, durationActualMinutes: 0, result: "ok результат" })).toThrowError(UserError);
    expect(() => validateReportInput({ participantsActual: 18.5, durationActualMinutes: 55, result: "ok результат" })).toThrowError(UserError);
    expect(() => validateReportInput({ participantsActual: 18, durationActualMinutes: 55, result: "ok" })).toThrowError(UserError);
  });
});

describe("конфликты расписания (двойные брони)", () => {
  const start = new Date(2026, 9, 10, 20, 0);
  const slot = (id: number, at: Date, durationMinutes: number) => ({
    id,
    code: `MP-${String(id).padStart(4, "0")}`,
    title: `Мероприятие ${id}`,
    scheduledAt: at,
    durationMinutes,
    organizerId: `user-${id}`,
  });

  it("интервалы: пересечение и касание границ", () => {
    // Полное содержание: [10:00–11:00] внутри [09:00–12:00].
    expect(intervalsOverlap(
      new Date(2026, 9, 10, 10).getTime(), new Date(2026, 9, 10, 11).getTime(),
      new Date(2026, 9, 10, 9).getTime(), new Date(2026, 9, 10, 12).getTime()
    )).toBe(true);
    // Касание: одно заканчивается, когда начинается другое — не конфликт.
    expect(intervalsOverlap(
      new Date(2026, 9, 10, 20).getTime(), new Date(2026, 9, 10, 21).getTime(),
      new Date(2026, 9, 10, 21).getTime(), new Date(2026, 9, 10, 22).getTime()
    )).toBe(false);
    // Разные дни — нет пересечения.
    expect(intervalsOverlap(
      new Date(2026, 9, 10, 20).getTime(), new Date(2026, 9, 10, 22).getTime(),
      new Date(2026, 9, 11, 20).getTime(), new Date(2026, 9, 11, 22).getTime()
    )).toBe(false);
  });

  it("находит пересекающиеся МП и игнорирует непересекающиеся", () => {
    const conflicts = findScheduleConflicts(
      [
        slot(1, start, 60),                       // 20:00–21:00 — конфликт
        slot(2, new Date(2026, 9, 10, 22, 0), 60), // 22:00–23:00 — свободно
        slot(3, new Date(2026, 9, 10, 19, 0), 60), // 19:00–20:00 — касание, не конфликт
      ],
      { scheduledAt: new Date(2026, 9, 10, 20, 30), durationMinutes: 60 }
    );
    expect(conflicts.map((c) => c.id)).toEqual([1]);
  });

  it("учитывает длительность кандидата и длительность существующего МП", () => {
    // Кандидат 20:00 (60 мин), существующее 21:30 (60 мин) — не пересекаются.
    expect(findScheduleConflicts([slot(1, new Date(2026, 9, 10, 21, 30), 60)], { scheduledAt: start, durationMinutes: 60 })).toHaveLength(0);
    // Кандидат 20:00 (120 мин) — пересекается с 21:30.
    expect(findScheduleConflicts([slot(1, new Date(2026, 9, 10, 21, 30), 60)], { scheduledAt: start, durationMinutes: 120 })).toHaveLength(1);
    // Существующее длительное (240 мин с 18:00) пересекается с кандидатом в 20:00.
    expect(findScheduleConflicts([slot(1, new Date(2026, 9, 10, 18, 0), 240)], { scheduledAt: start, durationMinutes: 30 })).toHaveLength(1);
  });

  it("excludeId исключает редактируемое мероприятие", () => {
    const conflicts = findScheduleConflicts([slot(1, start, 60)], { scheduledAt: start, durationMinutes: 60, excludeId: 1 });
    expect(conflicts).toHaveLength(0);
    expect(findScheduleConflicts([slot(1, start, 60)], { scheduledAt: start, durationMinutes: 60, excludeId: 2 })).toHaveLength(1);
  });

  it("результат отсортирован по времени начала", () => {
    const conflicts = findScheduleConflicts(
      [
        slot(2, new Date(2026, 9, 10, 21, 0), 60),
        slot(1, new Date(2026, 9, 10, 20, 0), 120),
      ],
      { scheduledAt: new Date(2026, 9, 10, 20, 30), durationMinutes: 120 }
    );
    expect(conflicts.map((c) => c.id)).toEqual([1, 2]);
  });

  it("describeConflicts перечисляет код, время и организатора", () => {
    const text = describeConflicts([slot(1, start, 60)]);
    expect(text).toContain("MP-0001");
    expect(text).toContain("20:00");
    expect(text).toContain("21:00");
    expect(text).toContain("user-1");
    expect(text).toContain("другое время");
  });
});
