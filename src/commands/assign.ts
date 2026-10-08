import { SlashCommandBuilder, type AutocompleteInteraction, type ChatInputCommandInteraction, type Client } from "discord.js";
import { commandContext, ephemeral, requirePermission } from "../interactions/shared";
import { UserError } from "../lib/errors";
import { successEmbed, withFooter } from "../lib/embeds";
import { assignOrganizer } from "../services/events";
import { prisma } from "../lib/db";
import { hasAtLeast, type Position } from "../permissions/matrix";
import { VIS_STAFF, autocompleteEvents, autocompleteStaff, eventFromOption } from "./common";

export const data = new SlashCommandBuilder()
  .setName("assign")
  .setDescription("Назначить организатора мероприятия")
  .setDefaultMemberPermissions(VIS_STAFF)
  .addStringOption((o) => o.setName("event").setDescription("Код мероприятия").setRequired(true).setAutocomplete(true))
  .addStringOption((o) =>
    o.setName("organizer").setDescription("Сотрудник (из базы отдела)").setRequired(true).setAutocomplete(true)
  );

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused(true);
  if (focused.name === "event") return autocompleteEvents(interaction);
  return autocompleteStaff(interaction, "ASSISTANT");
}

export async function execute(interaction: ChatInputCommandInteraction, client: Client): Promise<void> {
  const ctx = await commandContext(interaction);
  await requirePermission(ctx, "ASSIGN");

  const event = await eventFromOption(interaction);
  const organizerId = interaction.options.getString("organizer", true).trim();

  const target = await prisma.user.findUnique({ where: { discordId: organizerId } });
  if (!target || target.leftAt) {
    throw new UserError("Сотрудник не найден в базе отдела. Сначала назначьте должность через /promote.");
  }
  const position = target.position as Position;
  if (!hasAtLeast(position, "ASSISTANT")) {
    throw new UserError("Назначить организатором можно только сотрудника отдела (Помощник Организаторов и выше).");
  }

  const updated = await assignOrganizer(client, event, interaction.user, organizerId);

  await ephemeral(interaction, {
    embeds: [withFooter(successEmbed("👤 Организатор назначен", `\`${updated.code}\` → <@${organizerId}>. Сотрудник уведомлён в ЛС.`))],
  });
}
