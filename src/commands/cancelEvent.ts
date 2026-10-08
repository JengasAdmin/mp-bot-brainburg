import { SlashCommandBuilder, type ChatInputCommandInteraction, type Client } from "discord.js";
import { commandContext, ephemeral, requirePermission } from "../interactions/shared";
import { UserError } from "../lib/errors";
import { successEmbed, withFooter } from "../lib/embeds";
import { cancelEvent } from "../services/events";
import { STATUS_RU } from "../constants";
import { eventFromOption } from "./common";

export const data = new SlashCommandBuilder()
  .setName("cancel-event")
  .setDescription("Отменить мероприятие с указанием причины")
  .addStringOption((o) => o.setName("event").setDescription("Код мероприятия").setRequired(true).setAutocomplete(true))
  .addStringOption((o) =>
    o.setName("reason").setDescription("Причина отмены (будет видна автору)").setRequired(true).setMaxLength(500)
  );

export async function execute(interaction: ChatInputCommandInteraction, client: Client): Promise<void> {
  const ctx = await commandContext(interaction);
  const event = await eventFromOption(interaction);

  if (event.authorId !== ctx.userId && event.organizerId !== ctx.userId) {
    await requirePermission(ctx, "REVIEW");
  }

  const reason = interaction.options.getString("reason", true).trim();
  if (reason.length < 5) throw new UserError("Причина слишком короткая (минимум 5 символов).");

  const updated = await cancelEvent(client, event, interaction.user, reason);

  await ephemeral(interaction, {
    embeds: [
      withFooter(
        successEmbed(
          "🚫 Мероприятие отменено",
          `\`${updated.code}\` «${updated.title}» — статус «${STATUS_RU[updated.status].label}». Автор уведомлён.`
        )
      ),
    ],
  });
}
