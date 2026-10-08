import { SlashCommandBuilder, type ChatInputCommandInteraction, type Client } from "discord.js";
import { commandContext, ephemeral, requirePermission } from "../interactions/shared";
import { successEmbed, withFooter } from "../lib/embeds";
import { archiveEvent } from "../services/events";
import { VIS_LEADERSHIP, eventFromOption } from "./common";

export const data = new SlashCommandBuilder()
  .setName("archive")
  .setDescription("Заархивировать мероприятие после сдачи отчёта (данные сохраняются)")
  .setDefaultMemberPermissions(VIS_LEADERSHIP)
  .addStringOption((o) => o.setName("event").setDescription("Код мероприятия").setRequired(true).setAutocomplete(true));

export async function execute(interaction: ChatInputCommandInteraction, client: Client): Promise<void> {
  const ctx = await commandContext(interaction);
  await requirePermission(ctx, "ARCHIVE");
  const event = await eventFromOption(interaction);

  const updated = await archiveEvent(client, event, interaction.user);

  await ephemeral(interaction, {
    embeds: [
      withFooter(
        successEmbed(
          "🗃️ Мероприятие заархивировано",
          `\`${updated.code}\` «${updated.title}» закрыто. Заявка, история статусов, отчёт и участники сохранены в БД.`
        )
      ),
    ],
  });
}
