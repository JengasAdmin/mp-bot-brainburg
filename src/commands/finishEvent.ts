import { SlashCommandBuilder, type ChatInputCommandInteraction, type Client } from "discord.js";
import { commandContext, ephemeral } from "../interactions/shared";
import { successEmbed, withFooter } from "../lib/embeds";
import { finishEvent } from "../services/events";
import { STATUS_RU } from "../constants";
import { assertCanManageEvent, eventFromOption } from "./common";

export const data = new SlashCommandBuilder()
  .setName("finish-event")
  .setDescription("Завершить проведение МП и запросить отчёт")
  .addStringOption((o) => o.setName("event").setDescription("Код мероприятия").setRequired(true).setAutocomplete(true));

export async function execute(interaction: ChatInputCommandInteraction, client: Client): Promise<void> {
  const ctx = await commandContext(interaction);
  const event = await eventFromOption(interaction);
  assertCanManageEvent(ctx, event);

  const updated = await finishEvent(client, event, interaction.user);

  await ephemeral(interaction, {
    embeds: [
      withFooter(
        successEmbed(
          "🏁 МП завершено",
          `\`${updated.code}\` → «${STATUS_RU[updated.status].label}».\nТеперь создайте отчёт: \`/report event:${updated.code}\`.`
        )
      ),
    ],
  });
}
