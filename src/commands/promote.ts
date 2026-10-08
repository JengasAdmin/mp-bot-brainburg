import { SlashCommandBuilder, type ChatInputCommandInteraction, type Client } from "discord.js";
import { commandContext, ephemeral, requirePermission } from "../interactions/shared";
import { UserError } from "../lib/errors";
import { successEmbed, withFooter } from "../lib/embeds";
import { setPosition } from "../services/personnel";
import { POSITION_RU, type Position } from "../permissions/matrix";
import { VIS_LEADERSHIP } from "./common";

export const data = new SlashCommandBuilder()
  .setName("promote")
  .setDescription("Кадровое решение: назначить/изменить должность сотрудника")
  .setDefaultMemberPermissions(VIS_LEADERSHIP)
  .addUserOption((o) => o.setName("user").setDescription("Сотрудник").setRequired(true))
  .addStringOption((o) =>
    o
      .setName("position")
      .setDescription("Новая должность")
      .setRequired(true)
      .addChoices(
        { name: "Куратор", value: "CURATOR" },
        { name: "Главный Организатор МП", value: "HEAD" },
        { name: "Старший Организатор МП", value: "SENIOR" },
        { name: "Организатор МП", value: "ORGANIZER" },
        { name: "Помощник Организаторов", value: "ASSISTANT" }
      )
  )
  .addStringOption((o) =>
    o.setName("reason").setDescription("Причина решения (будет в журнале)").setRequired(true).setMaxLength(500)
  );

export async function execute(interaction: ChatInputCommandInteraction, client: Client): Promise<void> {
  const ctx = await commandContext(interaction);
  await requirePermission(ctx, "PROMOTE");

  const guild = interaction.guild;
  if (!guild) throw new UserError("Команда доступна только на сервере.");

  const targetUser = interaction.options.getUser("user", true);
  if (targetUser.bot) throw new UserError("Ботам должности не назначаются.");

  const newPosition = interaction.options.getString("position", true) as Position;
  const reason = interaction.options.getString("reason", true).trim();
  if (reason.length < 5) throw new UserError("Причина слишком короткая (минимум 5 символов).");

  // Назначение роли Главной Администрации — только самой Главной Администрации.
  const member = await guild.members.fetch(targetUser.id).catch(() => null);
  if (!member) throw new UserError("Сотрудник не найден на сервере.");

  await setPosition(client, guild, member, newPosition, interaction.user, reason);

  await ephemeral(interaction, {
    embeds: [
      withFooter(
        successEmbed(
          "⭐ Кадровое решение принято",
          `<@${targetUser.id}> → **${POSITION_RU[newPosition]}**.\nПричина: ${reason}\nЗапись внесена в журнал аудита.`
        )
      ),
    ],
  });
}
