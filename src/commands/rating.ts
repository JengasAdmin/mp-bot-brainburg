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
import { getTopOrganizers, getUserRating, buildRatingEmbed } from "../services/rating";

export type RatingPeriod = "WEEKLY" | "MONTHLY" | "ALL_TIME";

const PERIOD_RU: Record<RatingPeriod, string> = {
  WEEKLY: "Неделя",
  MONTHLY: "Месяц",
  ALL_TIME: "Всё время",
};

export const data = new SlashCommandBuilder()
  .setName("rating")
  .setDescription("Рейтинг организаторов: очки за проведённые МП")
  .addStringOption((o) =>
    o
      .setName("period")
      .setDescription("Период")
      .setRequired(false)
      .addChoices(
        { name: "Неделя", value: "WEEKLY" },
        { name: "Месяц", value: "MONTHLY" },
        { name: "Всё время", value: "ALL_TIME" }
      )
  )
  .addUserOption((o) =>
    o
      .setName("user")
      .setDescription("Показать рейтинг конкретного организатора")
      .setRequired(false)
  );

export function periodSelectRow(selected: RatingPeriod): ActionRowBuilder<StringSelectMenuBuilder> {
  const menu = new StringSelectMenuBuilder()
    .setCustomId("sel:rating")
    .setPlaceholder(`Период: ${PERIOD_RU[selected]}`)
    .addOptions(
      (Object.keys(PERIOD_RU) as RatingPeriod[]).map((p) =>
        new StringSelectMenuOptionBuilder().setLabel(PERIOD_RU[p]).setValue(p)
      )
    );
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

export async function execute(interaction: ChatInputCommandInteraction, client: Client): Promise<void> {
  const ctx = await commandContext(interaction);
  await requirePermission(ctx, "STATS_VIEW");

  const period = (interaction.options.getString("period") as RatingPeriod | null) ?? "ALL_TIME";
  const targetUser = interaction.options.getUser("user");

  if (targetUser) {
    // Показываем рейтинг конкретного пользователя
    const rating = await getUserRating(ctx.guildId, targetUser.id, period);
    if (!rating) {
      await interaction.reply({
        content: `У пользователя ${targetUser} пока нет очков рейтинга.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const embed = buildRatingEmbed([rating], period, interaction.guild?.name ?? "Отдел");
    await interaction.reply({
      embeds: [withFooter(embed)],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Показываем топ организаторов
  const top = await getTopOrganizers(ctx.guildId, period, 10);
  const embed = buildRatingEmbed(top, period, interaction.guild?.name ?? "Отдел");

  await interaction.reply({
    embeds: [withFooter(embed)],
    components: [periodSelectRow(period)],
    flags: MessageFlags.Ephemeral,
  });
}
