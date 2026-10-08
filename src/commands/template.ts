import {
  ActionRowBuilder,
  MessageFlags,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type ChatInputCommandInteraction,
  type Client,
} from "discord.js";
import { commandContext, ephemeral, requirePermission } from "../interactions/shared";
import { withFooter } from "../lib/embeds";
import {
  createTemplate,
  getTemplates,
  getTemplate,
  deleteTemplate,
  buildTemplatesEmbed,
  buildTemplateEmbed,
  type TemplateInput,
} from "../services/templates";
import { prisma } from "../lib/db";

export const data = new SlashCommandBuilder()
  .setName("template")
  .setDescription("Шаблоны мероприятий: быстрое создание МП из сохранённого сценария")
  .addSubcommand((sub) =>
    sub
      .setName("create")
      .setDescription("Создать новый шаблон МП")
      .addStringOption((o) =>
        o.setName("name").setDescription("Название шаблона").setRequired(true)
      )
      .addIntegerOption((o) =>
        o.setName("category_id").setDescription("ID категории МП").setRequired(true)
      )
      .addStringOption((o) =>
        o.setName("description").setDescription("Описание мероприятия").setRequired(true)
      )
      .addStringOption((o) =>
        o.setName("rules").setDescription("Правила мероприятия").setRequired(false)
      )
      .addIntegerOption((o) =>
        o.setName("duration").setDescription("Продолжительность (мин)").setRequired(false)
      )
      .addIntegerOption((o) =>
        o.setName("participants").setDescription("Количество участников").setRequired(false)
      )
      .addStringOption((o) =>
        o.setName("location").setDescription("Место проведения").setRequired(false)
      )
  )
  .addSubcommand((sub) =>
    sub.setName("list").setDescription("Список всех шаблонов МП")
  )
  .addSubcommand((sub) =>
    sub
      .setName("use")
      .setDescription("Использовать шаблон для создания МП")
      .addIntegerOption((o) =>
        o.setName("template_id").setDescription("ID шаблона").setRequired(true)
      )
      .addStringOption((o) =>
        o.setName("date").setDescription("Дата (ДД.ММ.ГГГГ)").setRequired(true)
      )
      .addStringOption((o) =>
        o.setName("time").setDescription("Время (ЧЧ:ММ)").setRequired(true)
      )
      .addStringOption((o) =>
        o.setName("title").setDescription("Название МП (переопределяет название шаблона)").setRequired(false)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("delete")
      .setDescription("Удалить шаблон")
      .addIntegerOption((o) =>
        o.setName("template_id").setDescription("ID шаблона").setRequired(true)
      )
  );

export async function execute(interaction: ChatInputCommandInteraction, client: Client): Promise<void> {
  const ctx = await commandContext(interaction);
  const subcommand = interaction.options.getSubcommand();

  switch (subcommand) {
    case "create": {
      await requirePermission(ctx, "CREATE_APPLICATION");

      const input: TemplateInput = {
        name: interaction.options.getString("name", true),
        categoryId: interaction.options.getInteger("category_id", true),
        description: interaction.options.getString("description", true),
        rules: interaction.options.getString("rules") ?? undefined,
        durationMinutes: interaction.options.getInteger("duration") ?? 60,
        participantsPlanned: interaction.options.getInteger("participants") ?? 20,
        location: interaction.options.getString("location") ?? undefined,
      };

      const template = await createTemplate(client, ctx.guildId, interaction.user, input);

      await interaction.reply({
        embeds: [withFooter(buildTemplateEmbed(template))],
        flags: MessageFlags.Ephemeral,
      });
      break;
    }

    case "list": {
      await requirePermission(ctx, "STATS_VIEW");

      const templates = await getTemplates(ctx.guildId);
      const embed = buildTemplatesEmbed(templates, interaction.guild?.name ?? "Отдел");

      await interaction.reply({
        embeds: [withFooter(embed)],
        flags: MessageFlags.Ephemeral,
      });
      break;
    }

    case "use": {
      await requirePermission(ctx, "CREATE_APPLICATION");

      const templateId = interaction.options.getInteger("template_id", true);
      const title = interaction.options.getString("title") ?? undefined;
      const dateStr = interaction.options.getString("date", true);
      const timeStr = interaction.options.getString("time", true);

      // Получаем шаблон
      const template = await getTemplate(templateId);

      // Создаём селект для подтверждения
      const embed = buildTemplateEmbed(template);
      embed.setDescription(
        embed.data.description + "\n\n**Использовать этот шаблон для создания МП?**\n" +
        `Дата: ${dateStr} ${timeStr}`
      );

      const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`sel:template-use:${templateId}:${dateStr}:${timeStr}:${title ?? ""}`)
          .setPlaceholder("Выберите действие")
          .addOptions(
            new StringSelectMenuOptionBuilder()
              .setLabel("Использовать шаблон")
              .setValue("use")
              .setEmoji("✅"),
            new StringSelectMenuOptionBuilder()
              .setLabel("Отмена")
              .setValue("cancel")
              .setEmoji("❌")
          )
      );

      await interaction.reply({
        embeds: [withFooter(embed)],
        components: [row],
        flags: MessageFlags.Ephemeral,
      });
      break;
    }

    case "delete": {
      await requirePermission(ctx, "EDIT_ANY_EVENT");

      const templateId = interaction.options.getInteger("template_id", true);
      await deleteTemplate(client, ctx.guildId, templateId, interaction.user);

      await interaction.reply({
        content: `Шаблон #${templateId} успешно удалён.`,
        flags: MessageFlags.Ephemeral,
      });
      break;
    }
  }
}
