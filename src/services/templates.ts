import type { Client, User } from "discord.js";
import type { EventTemplate } from "@prisma/client";
import { prisma } from "../lib/db";
import { UserError } from "../lib/errors";
import { baseEmbed, withFooter } from "../lib/embeds";
import { COLORS } from "../constants";
import { logger } from "../lib/logger";
import { writeAudit } from "./audit";
import { notifyUser } from "./notifications";

// ─────────────────────────── Создание шаблона ───────────────────────────

export interface TemplateInput {
  name: string;
  categoryId: number;
  description: string;
  rules?: string;
  durationMinutes: number;
  participantsPlanned: number;
  location?: string;
  extraInfo?: string;
}

/**
 * Создаёт новый шаблон мероприятия.
 */
export async function createTemplate(
  client: Client,
  guildId: string,
  creator: User,
  input: TemplateInput
): Promise<EventTemplate> {
  // Проверяем, что категория существует
  const category = await prisma.eventCategory.findUnique({
    where: { id: input.categoryId },
  });
  if (!category || category.guildId !== guildId) {
    throw new UserError("Выбранная категория не существует.");
  }

  const template = await prisma.eventTemplate.create({
    data: {
      guildId,
      name: input.name,
      categoryId: input.categoryId,
      description: input.description,
      rules: input.rules,
      durationMinutes: input.durationMinutes,
      participantsPlanned: input.participantsPlanned,
      location: input.location,
      extraInfo: input.extraInfo,
      createdById: creator.id,
    },
  });

  await writeAudit(client, {
    guildId,
    action: "TEMPLATE_CREATED",
    actorId: creator.id,
    actorTag: creator.tag,
    targetType: "template",
    targetId: String(template.id),
    newValue: template.name,
  });

  logger.info(`Создан шаблон «${template.name}» (ID: ${template.id})`);
  return template;
}

// ─────────────────────────── Получение шаблонов ───────────────────────────

/**
 * Получает список активных шаблонов.
 */
export async function getTemplates(guildId: string): Promise<EventTemplate[]> {
  return prisma.eventTemplate.findMany({
    where: { guildId, active: true },
    orderBy: { usageCount: "desc" },
  });
}

/**
 * Получает шаблон по ID.
 */
export async function getTemplate(id: number): Promise<EventTemplate> {
  const template = await prisma.eventTemplate.findUnique({
    where: { id },
  });
  if (!template) {
    throw new UserError("Шаблон не найден.");
  }
  return template;
}

// ─────────────────────────── Использование шаблона ───────────────────────────

/**
 * Использует шаблон для создания заявки на МП.
 * Возвращает данные для создания события.
 */
export async function useTemplate(
  templateId: number,
  overrides: {
    title?: string;
    dateStr: string;
    timeStr: string;
    description?: string;
  }
): Promise<{
  title: string;
  categoryId: number;
  description: string;
  rules?: string;
  durationMinutes: number;
  participantsPlanned: number;
  location?: string;
  extraInfo?: string;
}> {
  const template = await getTemplate(templateId);

  // Увеличиваем счётчик использования
  await prisma.eventTemplate.update({
    where: { id: templateId },
    data: { usageCount: { increment: 1 } },
  });

  return {
    title: overrides.title ?? template.name,
    categoryId: template.categoryId,
    description: overrides.description ?? template.description,
    rules: template.rules ?? undefined,
    durationMinutes: template.durationMinutes,
    participantsPlanned: template.participantsPlanned,
    location: template.location ?? undefined,
    extraInfo: template.extraInfo ?? undefined,
  };
}

// ─────────────────────────── Удаление шаблона ───────────────────────────

/**
 * Удаляет (деактивирует) шаблон.
 */
export async function deleteTemplate(
  client: Client,
  guildId: string,
  templateId: number,
  actor: User
): Promise<void> {
  const template = await prisma.eventTemplate.findUnique({
    where: { id: templateId },
  });
  if (!template || template.guildId !== guildId) {
    throw new UserError("Шаблон не найден.");
  }

  await prisma.eventTemplate.update({
    where: { id: templateId },
    data: { active: false },
  });

  await writeAudit(client, {
    guildId,
    action: "TEMPLATE_DELETED",
    actorId: actor.id,
    actorTag: actor.tag,
    targetType: "template",
    targetId: String(templateId),
    oldValue: template.name,
  });

  logger.info(`Шаблон «${template.name}» (ID: ${templateId}) деактивирован`);
}

// ─────────────────────────── Embed для шаблонов ───────────────────────────

/**
 * Создаёт embed со списком шаблонов.
 */
export function buildTemplatesEmbed(
  templates: EventTemplate[],
  guildName: string
): ReturnType<typeof baseEmbed> {
  const embed = baseEmbed("📦 Шаблоны мероприятий")
    .setColor(COLORS.INFO)
    .setDescription(
      templates.length === 0
        ? "Шаблонов пока нет. Создайте первый командой `/template create`."
        : templates
            .map((t) => {
              const usage = t.usageCount > 0 ? ` — использован ${t.usageCount} раз` : "";
              return `**${t.name}** (ID: ${t.id})${usage}\n${t.description.slice(0, 100)}${t.description.length > 100 ? "…" : ""}`;
            })
            .join("\n\n")
    );

  embed.setFooter({ text: `Сервер: ${guildName}` });
  return withFooter(embed);
}

/**
 * Создаёт embed с деталями шаблона.
 */
export function buildTemplateEmbed(
  template: EventTemplate
): ReturnType<typeof baseEmbed> {
  const embed = baseEmbed(`📦 Шаблон: ${template.name}`)
    .setColor(COLORS.INFO)
    .addFields(
      { name: "🆔 ID", value: String(template.id), inline: true },
      { name: "📂 Категория ID", value: String(template.categoryId), inline: true },
      { name: "📊 Использований", value: String(template.usageCount), inline: true },
      { name: "⏱️ Продолжительность", value: `${template.durationMinutes} мин`, inline: true },
      { name: "👥 Участников (план)", value: String(template.participantsPlanned), inline: true },
      { name: "📍 Место", value: template.location ?? "не указано", inline: true },
      { name: "📖 Описание", value: template.description.slice(0, 1000) || "—" },
    );

  if (template.rules) {
    embed.addFields({ name: "📏 Правила", value: template.rules.slice(0, 1000) });
  }
  if (template.extraInfo) {
    embed.addFields({ name: "ℹ️ Дополнительно", value: template.extraInfo.slice(0, 1000) });
  }

  return withFooter(embed);
}
