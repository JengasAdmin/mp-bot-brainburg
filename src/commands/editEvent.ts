import { SlashCommandBuilder, type ChatInputCommandInteraction, type Client } from "discord.js";
import { commandContext, requirePermission } from "../interactions/shared";
import { UserError } from "../lib/errors";
import { hasAtLeast } from "../permissions/matrix";
import { STATUS_RU } from "../constants";
import { editModal } from "../interactions/buttons";
import { VIS_STAFF, eventFromOption } from "./common";
import { EDITABLE_STATUSES } from "../services/rules";

export const data = new SlashCommandBuilder()
  .setName("edit-event")
  .setDescription("Редактировать заявку на МП (откроется форма)")
  .setDefaultMemberPermissions(VIS_STAFF)
  .addStringOption((o) =>
    o.setName("event").setDescription("Код мероприятия").setRequired(true).setAutocomplete(true)
  );

export async function execute(interaction: ChatInputCommandInteraction, _client: Client): Promise<void> {
  const ctx = await commandContext(interaction);
  const event = await eventFromOption(interaction);

  if (event.authorId !== ctx.userId) {
    await requirePermission(ctx, "EDIT_ANY_EVENT");
  } else if (!hasAtLeast(ctx.position, "ASSISTANT")) {
    throw new UserError("Редактировать заявку может только её автор или руководство.");
  }

  if (!EDITABLE_STATUSES.includes(event.status)) {
    throw new UserError(
      `Заявка в статусе «${STATUS_RU[event.status]?.label ?? event.status}» не редактируется.`
    );
  }

  await interaction.showModal(editModal(event.id, event));
}
