import {
  ActionRowBuilder,
  ModalBuilder,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Client,
} from "discord.js";
import { commandContext, ephemeral, requirePermission } from "../interactions/shared";
import { infoEmbed, successEmbed, withFooter } from "../lib/embeds";
import { UserError } from "../lib/errors";
import {
  archiveMaterial,
  attachMaterial,
  detachMaterial,
  formatMaterialBody,
  formatMaterialList,
  getMaterial,
  listEventMaterials,
  searchMaterials,
} from "../services/materials";
import { setDraft } from "../interactions/drafts";
import { prisma } from "../lib/db";
import { autocompleteEvents, eventFromOption } from "./common";

export const data = new SlashCommandBuilder()
  .setName("material")
  .setDescription("База материалов для игр: вопросы, темы, сценарии")
  .addSubcommand((s) =>
    s
      .setName("add")
      .setDescription("Добавить материал (название + содержимое в форме)")
      .addStringOption((o) => o.setName("title").setDescription("Название").setRequired(true).setMaxLength(100))
      .addStringOption((o) => o.setName("category").setDescription("Категория МП (например: Мафия)").setAutocomplete(true))
      .addStringOption((o) => o.setName("tags").setDescription("Теги через запятую").setMaxLength(200))
  )
  .addSubcommand((s) =>
    s
      .setName("list")
      .setDescription("Список материалов с поиском")
      .addStringOption((o) => o.setName("query").setDescription("Что искать (название, теги, содержимое)"))
  )
  .addSubcommand((s) =>
    s
      .setName("show")
      .setDescription("Показать материал целиком")
      .addStringOption((o) => o.setName("material").setDescription("Материал").setRequired(true).setAutocomplete(true))
  )
  .addSubcommand((s) =>
    s
      .setName("attach")
      .setDescription("Прикрепить материал к мероприятию")
      .addStringOption((o) => o.setName("event").setDescription("Мероприятие").setRequired(true).setAutocomplete(true))
      .addStringOption((o) => o.setName("material").setDescription("Материал").setRequired(true).setAutocomplete(true))
  )
  .addSubcommand((s) =>
    s
      .setName("detach")
      .setDescription("Открепить материал от мероприятия")
      .addStringOption((o) => o.setName("event").setDescription("Мероприятие").setRequired(true).setAutocomplete(true))
      .addStringOption((o) => o.setName("material").setDescription("Материал").setRequired(true).setAutocomplete(true))
  )
  .addSubcommand((s) =>
    s
      .setName("attached")
      .setDescription("Материалы, прикреплённые к мероприятию")
      .addStringOption((o) => o.setName("event").setDescription("Мероприятие").setRequired(true).setAutocomplete(true))
  )
  .addSubcommand((s) =>
    s
      .setName("delete")
      .setDescription("Убрать материал в архив (Старший Организатор и выше)")
      .addStringOption((o) => o.setName("material").setDescription("Материал").setRequired(true).setAutocomplete(true))
  );

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused(true);
  if (focused.name === "event") return autocompleteEvents(interaction);

  if (!interaction.guildId) return interaction.respond([]);

  if (focused.name === "category") {
    const categories = await prisma.eventCategory.findMany({
      where: { guildId: interaction.guildId, active: true, name: { contains: String(focused.value) } },
      orderBy: { name: "asc" },
      take: 25,
    });
    return interaction.respond(categories.map((c) => ({ name: c.name, value: c.name })));
  }

  if (focused.name === "material") {
    const materials = await searchMaterials(interaction.guildId, String(focused.value));
    return interaction.respond(
      materials.slice(0, 25).map((m) => ({
        name: `#${m.id} ${m.title}`.slice(0, 100),
        value: String(m.id),
      }))
    );
  }
  return interaction.respond([]);
}

export async function execute(interaction: ChatInputCommandInteraction, _client: Client): Promise<void> {
  const ctx = await commandContext(interaction);
  const sub = interaction.options.getSubcommand(true);

  switch (sub) {
    case "add": {
      await requirePermission(ctx, "CREATE_APPLICATION");
      const title = interaction.options.getString("title", true).trim();
      const tags = interaction.options.getString("tags") ?? "";
      const categoryName = interaction.options.getString("category");

      let categoryId: number | null = null;
      if (categoryName) {
        const category = await prisma.eventCategory.findFirst({
          where: { guildId: ctx.guildId, active: true, name: { equals: categoryName.trim() } },
        });
        if (!category) {
          throw new UserError(`Категория «${categoryName}» не найдена. Выберите название из автодополнения.`);
        }
        categoryId = category.id;
      }

      // Содержимое заполняется модальной формой (длинный текст неудобен в опции).
      setDraft(`mat:${interaction.user.id}`, { title, tags, categoryId });
      const modal = new ModalBuilder()
        .setCustomId("mdl:mat")
        .setTitle("Новый материал".slice(0, 45))
        .addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId("body")
              .setLabel("Содержимое (вопросы, темы, сценарий)")
              .setStyle(TextInputStyle.Paragraph)
              .setMinLength(5)
              .setMaxLength(3900)
              .setRequired(true)
          )
        );
      await interaction.showModal(modal);
      break;
    }
    case "list": {
      await requirePermission(ctx, "CREATE_APPLICATION");
      const query = interaction.options.getString("query") ?? "";
      const materials = await searchMaterials(ctx.guildId, query);
      await ephemeral(interaction, {
        embeds: [
          withFooter(
            infoEmbed(
              `📚 Материалы${query ? ` — «${query}»` : ""}`,
              formatMaterialList(materials).slice(0, 3800)
            )
          ),
        ],
      });
      break;
    }
    case "show": {
      await requirePermission(ctx, "CREATE_APPLICATION");
      const material = await getMaterial(ctx.guildId, interaction.options.getString("material", true));
      await ephemeral(interaction, {
        embeds: [withFooter(infoEmbed(`📚 #${material.id} ${material.title}`, formatMaterialBody(material)))],
      });
      break;
    }
    case "attach": {
      await requirePermission(ctx, "CREATE_APPLICATION");
      const event = await eventFromOption(interaction);
      const material = await getMaterial(ctx.guildId, interaction.options.getString("material", true));
      await attachMaterial(event.id, material.id, interaction.user.id);
      await ephemeral(interaction, {
        embeds: [successEmbed("📚 Материал прикреплён", `#${material.id} «${material.title}» → ${event.code}. Виден в карточке МП по кнопке «Материалы».`)],
      });
      break;
    }
    case "detach": {
      await requirePermission(ctx, "CREATE_APPLICATION");
      const event = await eventFromOption(interaction);
      const material = await getMaterial(ctx.guildId, interaction.options.getString("material", true));
      await detachMaterial(event.id, material.id);
      await ephemeral(interaction, {
        embeds: [successEmbed("📚 Материал откреплён", `#${material.id} «${material.title}» больше не прикреплён к ${event.code}.`)],
      });
      break;
    }
    case "attached": {
      await requirePermission(ctx, "CREATE_APPLICATION");
      const event = await eventFromOption(interaction);
      const materials = await listEventMaterials(event.id);
      await ephemeral(interaction, {
        embeds: [
          withFooter(
            infoEmbed(`📚 Материалы ${event.code}`, materials.length === 0 ? "Не прикреплены." : formatMaterialList(materials).slice(0, 3800))
          ),
        ],
      });
      break;
    }
    case "delete": {
      await requirePermission(ctx, "EDIT_ANY_EVENT");
      const material = await archiveMaterial(ctx.guildId, interaction.options.getString("material", true));
      await ephemeral(interaction, {
        embeds: [successEmbed("📚 Материал в архиве", `#${material.id} «${material.title}» скрыт из списка (привязки к МП сохранены).`)],
      });
      break;
    }
    default:
      throw new UserError("Неизвестная подкоманда.");
  }
}
