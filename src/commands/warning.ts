import { SlashCommandBuilder, type ChatInputCommandInteraction, type Client } from "discord.js";
import { commandContext, ephemeral, requirePermission } from "../interactions/shared";
import { UserError } from "../lib/errors";
import { warnEmbed, withFooter } from "../lib/embeds";
import { issueSanction } from "../services/personnel";
import { VIS_STAFF } from "./common";
import { formatDateTime } from "../lib/time";

export const data = new SlashCommandBuilder()
  .setName("warning")
  .setDescription("Выдать предупреждение сотруднику (фиксируется в журнале)")
  .setDefaultMemberPermissions(VIS_STAFF)
  .addUserOption((o) => o.setName("user").setDescription("Сотрудник").setRequired(true))
  .addStringOption((o) => o.setName("reason").setDescription("Причина").setRequired(true).setMaxLength(500))
  .addIntegerOption((o) =>
    o.setName("days").setDescription("Срок действия в днях (по умолчанию — бессрочно)").setMinValue(1).setMaxValue(365)
  );

export async function execute(interaction: ChatInputCommandInteraction, client: Client): Promise<void> {
  const ctx = await commandContext(interaction);
  await requirePermission(ctx, "WARN");

  const target = interaction.options.getUser("user", true);
  if (target.bot) throw new UserError("Ботам взыскания не выдаются.");
  const reason = interaction.options.getString("reason", true).trim();
  if (reason.length < 5) throw new UserError("Причина слишком короткая (минимум 5 символов).");

  const days = interaction.options.getInteger("days");
  const expiresAt = days ? new Date(Date.now() + days * 24 * 3600_000) : null;

  await issueSanction(client, ctx.guildId, target.id, "WARNING", reason, interaction.user, expiresAt);

  await ephemeral(interaction, {
    embeds: [
      withFooter(
        warnEmbed(
          "⚠️ Предупреждение выдано",
          `Сотрудник: <@${target.id}>\nПричина: ${reason}\n${expiresAt ? `Действует до: ${formatDateTime(expiresAt)}` : "Срок: бессрочно"}`
        )
      ),
    ],
  });
}
