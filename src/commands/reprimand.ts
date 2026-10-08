import { SlashCommandBuilder, type ChatInputCommandInteraction, type Client } from "discord.js";
import { commandContext, ephemeral, requirePermission } from "../interactions/shared";
import { UserError } from "../lib/errors";
import { warnEmbed, withFooter } from "../lib/embeds";
import { issueSanction } from "../services/personnel";
import { VIS_STAFF } from "./common";

export const data = new SlashCommandBuilder()
  .setName("reprimand")
  .setDescription("Выдать выговор сотруднику (фиксируется в журнале)")
  .setDefaultMemberPermissions(VIS_STAFF)
  .addUserOption((o) => o.setName("user").setDescription("Сотрудник").setRequired(true))
  .addStringOption((o) => o.setName("reason").setDescription("Причина").setRequired(true).setMaxLength(500));

export async function execute(interaction: ChatInputCommandInteraction, client: Client): Promise<void> {
  const ctx = await commandContext(interaction);
  await requirePermission(ctx, "WARN");

  const target = interaction.options.getUser("user", true);
  if (target.bot) throw new UserError("Ботам взыскания не выдаются.");
  const reason = interaction.options.getString("reason", true).trim();
  if (reason.length < 5) throw new UserError("Причина слишком короткая (минимум 5 символов).");

  await issueSanction(client, ctx.guildId, target.id, "REPRIMAND", reason, interaction.user);

  await ephemeral(interaction, {
    embeds: [withFooter(warnEmbed("🚫 Выговор выдан", `Сотрудник: <@${target.id}>\nПричина: ${reason}`))],
  });
}
