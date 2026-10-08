import { SlashCommandBuilder, type ChatInputCommandInteraction, type Client } from "discord.js";
import { commandContext, ephemeral, requirePermission } from "../interactions/shared";
import { UserError } from "../lib/errors";
import { successEmbed, withFooter } from "../lib/embeds";
import { rejectEvent } from "../services/events";
import { STATUS, STATUS_RU } from "../constants";
import { VIS_STAFF, eventFromOption } from "./common";

export const data = new SlashCommandBuilder()
  .setName("reject")
  .setDescription("Отклонить заявку на МП с указанием причины")
  .setDefaultMemberPermissions(VIS_STAFF)
  .addStringOption((o) => o.setName("event").setDescription("Код мероприятия").setRequired(true).setAutocomplete(true))
  .addStringOption((o) =>
    o.setName("reason").setDescription("Причина отклонения (отправится автору)").setRequired(true).setMaxLength(900)
  );

export async function execute(interaction: ChatInputCommandInteraction, client: Client): Promise<void> {
  const ctx = await commandContext(interaction);
  await requirePermission(ctx, "REVIEW");
  const event = await eventFromOption(interaction);

  if (event.status !== STATUS.PENDING && event.status !== STATUS.REVISION) {
    throw new UserError(`Заявка уже обработана (статус: ${STATUS_RU[event.status]?.label ?? event.status}).`);
  }

  const reason = interaction.options.getString("reason", true).trim();
  if (reason.length < 5) throw new UserError("Причина слишком короткая (минимум 5 символов).");

  const updated = await rejectEvent(client, event, interaction.user, reason);

  await ephemeral(interaction, {
    embeds: [withFooter(successEmbed("❌ Заявка отклонена", `\`${updated.code}\` — статус «${STATUS_RU[STATUS.REJECTED].label}». Автор уведомлён.`))],
  });
}
