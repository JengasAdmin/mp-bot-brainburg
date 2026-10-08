import { SlashCommandBuilder, type ChatInputCommandInteraction, type Client } from "discord.js";
import { commandContext, ephemeral, requirePermission } from "../interactions/shared";
import { UserError } from "../lib/errors";
import { successEmbed, withFooter } from "../lib/embeds";
import { requestRevision } from "../services/events";
import { STATUS, STATUS_RU } from "../constants";
import { VIS_STAFF, eventFromOption } from "./common";

export const data = new SlashCommandBuilder()
  .setName("request-revision")
  .setDescription("Отправить заявку автору на доработку")
  .setDefaultMemberPermissions(VIS_STAFF)
  .addStringOption((o) => o.setName("event").setDescription("Код мероприятия").setRequired(true).setAutocomplete(true))
  .addStringOption((o) =>
    o.setName("reason").setDescription("Что необходимо исправить").setRequired(true).setMaxLength(900)
  );

export async function execute(interaction: ChatInputCommandInteraction, client: Client): Promise<void> {
  const ctx = await commandContext(interaction);
  await requirePermission(ctx, "REVIEW");
  const event = await eventFromOption(interaction);

  if (event.status !== STATUS.PENDING) {
    throw new UserError(`Доработка запрошена только для заявок на проверке (сейчас: ${STATUS_RU[event.status]?.label ?? event.status}).`);
  }

  const reason = interaction.options.getString("reason", true).trim();
  if (reason.length < 5) throw new UserError("Описание доработки слишком короткое (минимум 5 символов).");

  const updated = await requestRevision(client, event, interaction.user, reason);

  await ephemeral(interaction, {
    embeds: [withFooter(successEmbed("✏️ Запрошена доработка", `\`${updated.code}\` — статус «${STATUS_RU[STATUS.REVISION].label}». Автор уведомлён в ЛС.`))],
  });
}
