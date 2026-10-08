import { MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction, type Client } from "discord.js";
import { commandContext, ephemeral, requirePermission } from "../interactions/shared";
import { successEmbed, withFooter } from "../lib/embeds";
import { finishInternship, internshipsEmbed, startInternship } from "../services/personnel";
import { VIS_LEADERSHIP } from "./common";

export const data = new SlashCommandBuilder()
  .setName("internship")
  .setDescription("Стажировка помощников: назначение наставника и итоги")
  .setDefaultMemberPermissions(VIS_LEADERSHIP)
  .addSubcommand((sc) =>
    sc
      .setName("start")
      .setDescription("Начать стажировку")
      .addUserOption((o) => o.setName("user").setDescription("Стажёр").setRequired(true))
      .addUserOption((o) => o.setName("mentor").setDescription("Наставник").setRequired(true))
  )
  .addSubcommand((sc) =>
    sc
      .setName("finish")
      .setDescription("Завершить стажировку (успешно)")
      .addUserOption((o) => o.setName("user").setDescription("Стажёр").setRequired(true))
      .addStringOption((o) => o.setName("note").setDescription("Комментарий руководства").setMaxLength(500))
  )
  .addSubcommand((sc) =>
    sc
      .setName("fail")
      .setDescription("Закрыть стажировку без прохождения")
      .addUserOption((o) => o.setName("user").setDescription("Стажёр").setRequired(true))
      .addStringOption((o) => o.setName("note").setDescription("Причина").setMaxLength(500))
  )
  .addSubcommand((sc) =>
    sc
      .setName("pause")
      .setDescription("Приостановить стажировку")
      .addUserOption((o) => o.setName("user").setDescription("Стажёр").setRequired(true))
      .addStringOption((o) => o.setName("note").setDescription("Причина").setMaxLength(500))
  )
  .addSubcommand((sc) => sc.setName("list").setDescription("Список активных стажировок"));

export async function execute(interaction: ChatInputCommandInteraction, client: Client): Promise<void> {
  const ctx = await commandContext(interaction);
  await requirePermission(ctx, "INTERNSHIP");

  const sub = interaction.options.getSubcommand();

  if (sub === "list") {
    const embed = await internshipsEmbed(ctx.guildId);
    await interaction.reply({ embeds: [withFooter(embed)], flags: MessageFlags.Ephemeral });
    return;
  }

  const user = interaction.options.getUser("user", true);

  if (sub === "start") {
    const mentor = interaction.options.getUser("mentor", true);
    await startInternship(client, ctx.guildId, user.id, mentor.id, interaction.user);
    await ephemeral(interaction, {
      embeds: [withFooter(successEmbed("📝 Стажировка начата", `Стажёр: <@${user.id}>\nНаставник: <@${mentor.id}>`))],
    });
    return;
  }

  const status = sub === "finish" ? "COMPLETED" : sub === "fail" ? "FAILED" : "PAUSED";
  const note = interaction.options.getString("note") ?? undefined;
  await finishInternship(client, ctx.guildId, user.id, status, interaction.user, note);

  const label = status === "COMPLETED" ? "завершена" : status === "FAILED" ? "закрыта без прохождения" : "приостановлена";
  await ephemeral(interaction, {
    embeds: [withFooter(successEmbed("✅ Готово", `Стажировка <@${user.id}> ${label}. Запись в журнале аудита.`))],
  });
}
