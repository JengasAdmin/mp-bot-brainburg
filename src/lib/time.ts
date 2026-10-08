import { UserError } from "./errors";

const DATE_RE = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/;
const TIME_RE = /^(\d{1,2}):(\d{2})$/;

/// Парсит дату «ДД.ММ.ГГГГ» и время «ЧЧ:ММ» в локальном времени сервера.
export function parseDateTime(dateStr: string, timeStr: string): Date {
  const d = dateStr.trim().match(DATE_RE);
  if (!d) throw new UserError("Неверный формат даты. Используйте ДД.ММ.ГГГГ, например 27.09.2026.");
  const t = timeStr.trim().match(TIME_RE);
  if (!t) throw new UserError("Неверный формат времени. Используйте ЧЧ:ММ, например 20:00.");

  const day = Number(d[1]);
  const month = Number(d[2]);
  const year = Number(d[3]);
  const hour = Number(t[1]);
  const minute = Number(t[2]);

  if (month < 1 || month > 12) throw new UserError("Месяц должен быть от 01 до 12.");
  if (day < 1 || day > 31) throw new UserError("День должен быть от 01 до 31.");
  if (hour > 23) throw new UserError("Час должен быть от 00 до 23.");
  if (minute > 59) throw new UserError("Минуты должны быть от 00 до 59.");

  const date = new Date(year, month - 1, day, hour, minute);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    throw new UserError("Такой даты не существует (например, 31.02).");
  }
  return date;
}

const MONTHS_RU = [
  "января", "февраля", "марта", "апреля", "мая", "июня",
  "июля", "августа", "сентября", "октября", "ноября", "декабря",
];

export function formatDateTime(date: Date): string {
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  return `${dd}.${mm}.${date.getFullYear()} ${hh}:${mi}`;
}

export function formatShortDate(date: Date): string {
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  return `${dd}.${mm}`;
}

export function formatTime(date: Date): string {
  const hh = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  return `${hh}:${mi}`;
}

/// Discord-разметка времени: <t:unix:F> — локальное отображение у пользователя.
export function discordTimestamp(date: Date, style: "t" | "f" | "R" = "f"): string {
  return `<t:${Math.floor(date.getTime() / 1000)}:${style}>`;
}

export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} мин`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} ч` : `${h} ч ${m} мин`;
}
