import { MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction, type Client } from "discord.js";
import { commandContext, ephemeral, requirePermission } from "../interactions/shared";
import { successEmbed, withFooter } from "../lib/embeds";
import { removeSanction, sanctionsBoardEmbed } from "../services/personnel";
import { VIS_STAFF } from "./common";

export const data = new SlashCommandBuilder()
  .setName("discipline")
  .setDescription("Дисциплина: активные взыскания и их снятие")
  .setDefaultMemberPermissions(VIS_STAFF)
  .addSubcommand((sc) => sc.setName("list").setDescription("Показать активные взыскания"))
  .addSubcommand((sc) =>
    sc
      .setName("remove")
      .setDescription("Снять взыскание")
      .addIntegerOption((o) => o.setName("id").setDescription("ID взыскания (из /discipline list)").setRequired(true).setMinValue(1))
      .addStringOption((o) => o.setName("reason").setDescription("Причина снятия").setMaxLength(500))
  );

export async function execute(interaction: ChatInputCommandInteraction, client: Client): Promise<void> {
  const ctx = await commandContext(interaction);
  await requirePermission(ctx, "WARN");

  const sub = interaction.options.getSubcommand();
  if (sub === "list") {
    const embed = await sanctionsBoardEmbed(ctx.guildId);
    await interaction.reply({ embeds: [withFooter(embed)], flags: MessageFlags.Ephemeral });
    return;
  }

  const id = interaction.options.getInteger("id", true);
  const reason = interaction.options.getString("reason")?.trim();
  await removeSanction(client, ctx.guildId, id, interaction.user, reason);

  await ephemeral(interaction, {
    embeds: [withFooter(successEmbed("✅ Взыскание снято", `Взыскание #${id} снято. Изменение записано в журнал.`))],
  });
}
