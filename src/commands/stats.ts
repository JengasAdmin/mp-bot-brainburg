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
import { statsEmbed } from "../services/stats";
import { STATS_PERIOD_RU, type StatsPeriod } from "../services/rules";

export const data = new SlashCommandBuilder()
  .setName("stats")
  .setDescription("Статистика отдела: мероприятия, участники, категории, организаторы")
  .addStringOption((o) =>
    o
      .setName("period")
      .setDescription("Период")
      .setRequired(false)
      .addChoices(
        { name: "Сегодня", value: "today" },
        { name: "Неделя", value: "week" },
        { name: "Месяц", value: "month" },
        { name: "Год", value: "year" },
        { name: "Всё время", value: "all" }
      )
  );

export function periodSelectRow(selected: StatsPeriod): ActionRowBuilder<StringSelectMenuBuilder> {
  const menu = new StringSelectMenuBuilder()
    .setCustomId("sel:stats")
    .setPlaceholder(`Период: ${STATS_PERIOD_RU[selected]}`)
    .addOptions(
      (Object.keys(STATS_PERIOD_RU) as StatsPeriod[]).map((p) =>
        new StringSelectMenuOptionBuilder().setLabel(STATS_PERIOD_RU[p]).setValue(p)
      )
    );
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

export async function execute(interaction: ChatInputCommandInteraction, client: Client): Promise<void> {
  const ctx = await commandContext(interaction);
  await requirePermission(ctx, "STATS_VIEW");

  const period = (interaction.options.getString("period") as StatsPeriod | null) ?? "all";
  const embed = await statsEmbed(ctx.guildId, interaction.guild?.name ?? "Отдел", period);

  await interaction.reply({
    embeds: [withFooter(embed)],
    components: [periodSelectRow(period)],
    flags: MessageFlags.Ephemeral,
  });
}
