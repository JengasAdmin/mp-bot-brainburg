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
import { getWeeklyCalendar, buildCalendarEmbed, type CalendarFilters } from "../services/calendar";
import { prisma } from "../lib/db";

export const data = new SlashCommandBuilder()
  .setName("calendar")
  .setDescription("Календарь мероприятий на неделю")
  .addIntegerOption((o) =>
    o.setName("category_id").setDescription("Фильтр по категории (ID)").setRequired(false)
  )
  .addUserOption((o) =>
    o.setName("organizer").setDescription("Фильтр по организатору").setRequired(false)
  );

export async function execute(interaction: ChatInputCommandInteraction, client: Client): Promise<void> {
  const ctx = await commandContext(interaction);
  await requirePermission(ctx, "STATS_VIEW");

  const categoryId = interaction.options.getInteger("category_id") ?? undefined;
  const organizer = interaction.options.getUser("organizer") ?? undefined;

  const filters: CalendarFilters = {
    categoryId,
    organizerId: organizer?.id,
  };

  const events = await getWeeklyCalendar(ctx.guildId, filters);
  const embed = buildCalendarEmbed(events, interaction.guild?.name ?? "Отдел", filters);

  await interaction.reply({
    embeds: [withFooter(embed)],
    flags: MessageFlags.Ephemeral,
  });
}
