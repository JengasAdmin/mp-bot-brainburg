import { SlashCommandBuilder, type ChatInputCommandInteraction, type Client } from "discord.js";
import { commandContext, requirePermission } from "../interactions/shared";
import { showCategorySelect } from "../interactions/buttons";
import { VIS_STAFF } from "./common";

export const data = new SlashCommandBuilder()
  .setName("create-event")
  .setDescription("Подать заявку на проведение МП (откроется форма)")
  .setDefaultMemberPermissions(VIS_STAFF);

export async function execute(interaction: ChatInputCommandInteraction, _client: Client): Promise<void> {
  const ctx = await commandContext(interaction);
  await requirePermission(ctx, "CREATE_APPLICATION");
  await showCategorySelect(interaction);
}
