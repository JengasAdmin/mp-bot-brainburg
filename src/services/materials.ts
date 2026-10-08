import type { Material } from "@prisma/client";
import { prisma } from "../lib/db";
import { UserError } from "../lib/errors";

/// База материалов для игр: вопросы, темы, сценарии. Хранится в БД,
/// ищется по названию/тегам/содержимому, прикрепляется к мероприятиям.

const MAX_BODY = 3900;
const MAX_TITLE = 100;

export interface MaterialInput {
  title: string;
  body: string;
  tags?: string;
  categoryId?: number | null;
}

export function validateMaterialInput(input: MaterialInput): MaterialInput {
  const title = input.title.trim();
  const body = input.body.trim();
  if (title.length < 3) throw new UserError("Название материала слишком короткое (минимум 3 символа).");
  if (title.length > MAX_TITLE) throw new UserError(`Название материала длиннее ${MAX_TITLE} символов.`);
  if (body.length < 5) throw new UserError("Содержимое материала слишком короткое (минимум 5 символов).");
  if (body.length > MAX_BODY) throw new UserError(`Содержимое длиннее ${MAX_BODY} символов.`);
  return {
    title,
    body,
    tags: (input.tags ?? "").trim().slice(0, 200),
    categoryId: input.categoryId ?? null,
  };
}

export async function createMaterial(guildId: string, authorId: string, input: MaterialInput): Promise<Material> {
  const valid = validateMaterialInput(input);
  if (valid.categoryId) {
    const category = await prisma.eventCategory.findUnique({ where: { id: valid.categoryId } });
    if (!category || category.guildId !== guildId) throw new UserError("Указанная категория не найдена.");
  }
  return prisma.material.create({
    data: {
      guildId,
      title: valid.title,
      body: valid.body,
      tags: valid.tags ?? "",
      categoryId: valid.categoryId,
      createdById: authorId,
    },
  });
}

/// Поиск материалов: по названию, тегам и содержимому (частичное совпадение).
export async function searchMaterials(guildId: string, query: string, includeArchived = false): Promise<Material[]> {
  const q = query.trim();
  return prisma.material.findMany({
    where: {
      guildId,
      ...(includeArchived ? {} : { active: true }),
      ...(q
        ? {
            OR: [
              { title: { contains: q } },
              { tags: { contains: q } },
              { body: { contains: q } },
            ],
          }
        : {}),
    },
    orderBy: { updatedAt: "desc" },
    take: 25,
  });
}

export async function getMaterial(guildId: string, ref: string): Promise<Material> {
  const id = Number(ref);
  const material =
    Number.isInteger(id) && id > 0
      ? await prisma.material.findFirst({ where: { id, guildId } })
      : await prisma.material.findFirst({ where: { guildId, title: { contains: ref.trim() }, active: true } });
  if (!material) throw new UserError(`Материал «${ref}» не найден. Посмотрите список через /material list.`);
  return material;
}

/// Мягкое удаление: материал скрывается из списка, привязки сохраняются.
export async function archiveMaterial(guildId: string, ref: string): Promise<Material> {
  const material = await getMaterial(guildId, ref);
  return prisma.material.update({ where: { id: material.id }, data: { active: false } });
}

// ─────────────────────────── Привязка к мероприятиям ───────────────────────────

export async function attachMaterial(eventId: number, materialId: number, actorId: string): Promise<void> {
  const existing = await prisma.eventMaterial.findUnique({
    where: { eventId_materialId: { eventId, materialId } },
  });
  if (existing) throw new UserError("Этот материал уже прикреплён к мероприятию.");
  await prisma.eventMaterial.create({ data: { eventId, materialId, addedById: actorId } });
  await prisma.material.update({ where: { id: materialId }, data: { usageCount: { increment: 1 } } });
}

export async function detachMaterial(eventId: number, materialId: number): Promise<void> {
  const existing = await prisma.eventMaterial.findUnique({
    where: { eventId_materialId: { eventId, materialId } },
  });
  if (!existing) throw new UserError("Материал не прикреплён к этому мероприятию.");
  await prisma.eventMaterial.delete({ where: { id: existing.id } });
}

export async function listEventMaterials(eventId: number): Promise<(Material & { addedById: string | null })[]> {
  const links = await prisma.eventMaterial.findMany({
    where: { eventId },
    include: { material: true },
    orderBy: { addedAt: "asc" },
  });
  return links.map((l) => ({ ...l.material, addedById: l.addedById }));
}

/// Список для сообщения (каждый пункт — заголовок, категория, теги).
export function formatMaterialList(materials: readonly Material[]): string {
  if (materials.length === 0) return "Материалы не найдены.";
  return materials
    .map((m) => {
      const tags = m.tags ? ` — _${m.tags}_` : "";
      return `**#${m.id}** ${m.title}${tags} (использован ${m.usageCount} раз${m.active ? "" : ", в архиве"})`;
    })
    .join("\n");
}

export function formatMaterialBody(m: Material): string {
  const parts = [m.body.slice(0, 3500)];
  if (m.tags) parts.push(`\n**Теги:** ${m.tags}`);
  parts.push(`\n_Использован в МП: ${m.usageCount} раз_`);
  return parts.join("\n");
}
