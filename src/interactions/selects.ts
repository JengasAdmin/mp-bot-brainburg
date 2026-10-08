import {
  ActionRowBuilder,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
  type AnySelectMenuInteraction,
} from "discord.js";
import { UserError } from "../lib/errors";
import { infoEmbed, successEmbed, withFooter } from "../lib/embeds";
import { ephemeral, requireContext, requirePermission, safeExecute } from "./shared";
import { assignOrganizer, loadEvent } from "../services/events";
import { startTest } from "../services/tests";
import { statsEmbed } from "../services/stats";
import { periodSelectRow } from "../commands/stats";
import type { StatsPeriod } from "../services/rules";
import { getTopOrganizers, buildRatingEmbed } from "../services/rating";
import { periodSelectRow as ratingPeriodSelectRow } from "../commands/rating";
import type { RatingPeriod } from "../commands/rating";
import { useTemplate } from "../services/templates";
import { createApplication } from "../services/events";

export async function handleSelect(interaction: AnySelectMenuInteraction): Promise<void> {
  const parts = interaction.customId.split(":");
  const [namespace, action, ...rest] = parts;
  if (namespace !== "app" && namespace !== "sel") return;

  await safeExecute(interaction, async () => {
    const ctx = await requireContext(interaction);

    switch (`${namespace}:${action}`) {
      case "app:cat": {
        await requirePermission(ctx, "CREATE_APPLICATION");
        const categoryId = Number(interaction.values[0]);
        const { ModalBuilder: MB, TextInputBuilder: TIB, TextInputStyle: TIS } = await import("discord.js");
        const modal = new MB().setCustomId(`mdl:app1:${categoryId}`).setTitle("Заявка на МП — шаг 1");
        const field = (id: string, label: string, style: (typeof TIS)[keyof typeof TIS], required: boolean, placeholder: string, maxLength = 900) =>
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TIB().setCustomId(id).setLabel(label).setStyle(style).setRequired(required).setPlaceholder(placeholder).setMaxLength(maxLength)
          );
        modal.addComponents(
          field("title", "Название МП", TIS.Short, true, "например Мафия на 20 человек", 100),
          field("description", "Описание", TIS.Paragraph, true, "Что за мероприятие, как проходит", 900),
          field("date", "Дата (ДД.ММ.ГГГГ)", TIS.Short, true, "например 28.09.2026", 10),
          field("time", "Время (ЧЧ:ММ)", TIS.Short, true, "например 20:00", 5),
          field("location", "Место проведения", TIS.Short, false, "например Discord voice / площадка", 100)
        );
        await interaction.showModal(modal);
        break;
      }
      case "sel:assign": {
        await requirePermission(ctx, "ASSIGN");
        const eventId = Number(rest[0]);
        const organizerId = interaction.values[0];
        const event = await assignOrganizer(interaction.client, await loadEvent(eventId), interaction.user, organizerId);
        await ephemeral(interaction, {
          embeds: [withFooter(successEmbed("👤 Организатор назначен", `${event.code} — <@${organizerId}> уведомлён в ЛС.`))],
        });
        break;
      }
      case "sel:tstpick": {
        const testId = Number(interaction.values[0]);
        await startTest(interaction.client, ctx.guildId, testId, interaction.user);
        await ephemeral(interaction, { embeds: [withFooter(successEmbed("🎓 Тест начат", "Первый вопрос отправлен вам в личные сообщения."))] });
        break;
      }
      case "sel:stats": {
        await requirePermission(ctx, "STATS_VIEW");
        const period = interaction.values[0] as StatsPeriod;
        const embed = await statsEmbed(ctx.guildId, interaction.guild?.name ?? "Отдел", period);
        await interaction.update({
          embeds: [withFooter(embed)],
          components: [periodSelectRow(period)],
        });
        break;
      }
      case "sel:rating": {
        await requirePermission(ctx, "STATS_VIEW");
        const period = interaction.values[0] as RatingPeriod;
        const top = await getTopOrganizers(ctx.guildId, period, 10);
        const embed = buildRatingEmbed(top, period, interaction.guild?.name ?? "Отдел");
        await interaction.update({
          embeds: [withFooter(embed)],
          components: [ratingPeriodSelectRow(period)],
        });
        break;
      }
      case "sel:template-use": {
        await requirePermission(ctx, "CREATE_APPLICATION");
        const [templateId, dateStr, timeStr, title] = rest;
        const templateData = await useTemplate(Number(templateId), {
          title: title || undefined,
          dateStr,
          timeStr,
        });

        const event = await createApplication(
          interaction.client,
          ctx.guildId,
          interaction.user,
          {
            ...templateData,
            dateStr,
            timeStr,
          }
        );

        await interaction.update({
          embeds: [withFooter(successEmbed("✅ МП создано из шаблона", `Заявка ${event.code} отправлена на проверку.`))],
          components: [],
        });
        break;
      }
      default:
        throw new UserError("Неизвестное меню выбора.");
    }
  });
}
