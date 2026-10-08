import { SlashCommandBuilder, type ChatInputCommandInteraction, type Client } from "discord.js";
import { commandContext, ephemeral, requirePermission } from "../interactions/shared";
import { UserError } from "../lib/errors";
import { successEmbed, withFooter } from "../lib/embeds";
import { approveEvent } from "../services/events";
import { STATUS, STATUS_RU } from "../constants";
import { VIS_STAFF, eventFromOption } from "./common";

export const data = new SlashCommandBuilder()
  .setName("approve")
  .setDescription("Одобрить заявку на МП: она уйдёт в планирование")
  .setDefaultMemberPermissions(VIS_STAFF)
  .addStringOption((o) => o.setName("event").setDescription("Код мероприятия").setRequired(true).setAutocomplete(true));

export async function execute(interaction: ChatInputCommandInteraction, client: Client): Promise<void> {
  const ctx = await commandContext(interaction);
  await requirePermission(ctx, "REVIEW");
  const event = await eventFromOption(interaction);

  if (event.status !== STATUS.PENDING && event.status !== STATUS.REVISION) {
    throw new UserError(`Заявка уже обработана (статус: ${STATUS_RU[event.status]?.label ?? event.status}).`);
  }

  const updated = await approveEvent(client, event, interaction.user);

  await ephemeral(interaction, {
    embeds: [
      withFooter(
        successEmbed(
          "✅ Заявка одобрена",
          `\`${updated.code}\` «${updated.title}» → **${STATUS_RU[STATUS.PLANNED].label}**.\n` +
            `Канал МП${updated.eventChannelId ? ` <#${updated.eventChannelId}>` : ""} и голосовой канал созданы. Автор уведомлён.`
        )
      ),
    ],
  });
}
