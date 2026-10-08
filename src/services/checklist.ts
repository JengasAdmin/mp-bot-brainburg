import type { ChecklistItem } from "@prisma/client";
import { prisma } from "../lib/db";
import { UserError } from "../lib/errors";
import { CHECKLIST_DEFS } from "../constants";

/// Чек-лист подготовки МП: создаётся при планировании, пункты с auto=true
/// закрывает бот (каналы, голосовая, анонс), остальные — организатор вручную.

/// Создаёт пункты чек-листа для мероприятия (идемпотентно).
export async function ensureChecklist(eventId: number): Promise<void> {
  for (const def of CHECKLIST_DEFS) {
    await prisma.checklistItem.upsert({
      where: { eventId_key: { eventId, key: def.key } },
      create: { eventId, key: def.key, label: def.label, auto: def.auto },
      update: {},
    });
  }
}

/// Пункты чек-листа в порядке CHECKLIST_DEFS (создаёт при отсутствии).
export async function getChecklist(eventId: number): Promise<ChecklistItem[]> {
  await ensureChecklist(eventId);
  const items = await prisma.checklistItem.findMany({ where: { eventId } });
  const order = new Map<string, number>(CHECKLIST_DEFS.map((d, i) => [d.key, i]));
  return items.sort((a, b) => (order.get(a.key) ?? 99) - (order.get(b.key) ?? 99));
}

/// Закрывает (или открывает) ручной пункт по кнопке. auto-пункты
/// доступны только для закрытия ботом — вручную не переключаются.
export async function toggleChecklistItem(
  eventId: number,
  key: string,
  actorId: string
): Promise<ChecklistItem> {
  const def = CHECKLIST_DEFS.find((d) => d.key === key);
  if (!def) throw new UserError("Неизвестный пункт чек-листа.");
  if (def.auto) throw new UserError("Этот пункт закрывается ботом автоматически.");

  await ensureChecklist(eventId);
  const current = await prisma.checklistItem.findUniqueOrThrow({
    where: { eventId_key: { eventId, key: def.key } },
  });
  return prisma.checklistItem.update({
    where: { id: current.id },
    data: {
      done: !current.done,
      doneById: !current.done ? actorId : null,
      doneAt: !current.done ? new Date() : null,
    },
  });
}

/// Автозакрытие пункта ботом (каналы созданы, голосовая готова, анонс опубликован).
export async function markChecklist(eventId: number, key: string, done = true): Promise<void> {
  const def = CHECKLIST_DEFS.find((d) => d.key === key);
  if (!def) return;
  await prisma.checklistItem.upsert({
    where: { eventId_key: { eventId, key } },
    create: { eventId, key, label: def.label, auto: def.auto, done },
    update: { done, ...(done ? { doneAt: new Date() } : {}) },
  });
}

/// Незакрытые пункты. Если чек-лист ещё не создан — создаёт и возвращает.
export async function findUndone(eventId: number): Promise<ChecklistItem[]> {
  const items = await getChecklist(eventId);
  return items.filter((i) => !i.done);
}

/// Бросает UserError со списком незакрытых пунктов (блокировка запуска МП).
export async function assertChecklistComplete(eventId: number): Promise<void> {
  const undone = await findUndone(eventId);
  if (undone.length === 0) return;
  const lines = undone.map((i) => `• ${i.label}`);
  throw new UserError(
    `Чек-лист подготовки не закрыт:\n${lines.join("\n")}\n` +
      `Отметьте пункты кнопкой «Чек-лист» в карточке МП.`
  );
}

/// Текстовое представление для эмбеда (✅/⬜ + кто закрыл).
export function formatChecklist(items: readonly ChecklistItem[]): string {
  if (items.length === 0) return "Чек-лист пуст.";
  return items
    .map((i) => `${i.done ? "✅" : "⬜"} ${i.label}${i.done && i.doneById ? ` — <@${i.doneById}>` : ""}`)
    .join("\n");
}
