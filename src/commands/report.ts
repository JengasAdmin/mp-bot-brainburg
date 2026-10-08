import { SlashCommandBuilder, type ChatInputCommandInteraction, type Client } from "discord.js";
import { commandContext } from "../interactions/shared";
import { UserError } from "../lib/errors";
import { reportModal } from "../interactions/buttons";
import { STATUS_RU } from "../constants";
import { assertCanManageEvent, eventFromOption } from "./common";

export const data = new SlashCommandBuilder()
  .setName("report")
  .setDescription("Создать отчёт по завершённому МП")
  .addStringOption((o) => o.setName("event").setDescription("Код мероприятия").setRequired(true).setAutocomplete(true));

export async function execute(interaction: ChatInputCommandInteraction, _client: Client): Promise<void> {
  const ctx = await commandContext(interaction);
  const event = await eventFromOption(interaction);
  assertCanManageEvent(ctx, event);

  if (event.status !== "COMPLETED") {
    throw new UserError(`Отчёт создаётся после завершения МП (сейчас: ${STATUS_RU[event.status]?.label ?? event.status}).`);
  }
  if (event.report) throw new UserError(`Отчёт по ${event.code} уже сдан.`);

  await interaction.showModal(reportModal(event.id));
}
