import { MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction, type Client } from "discord.js";
import { commandContext, ephemeral, requirePermission } from "../interactions/shared";
import { UserError } from "../lib/errors";
import { baseEmbed, COLORS, withFooter } from "../lib/embeds";
import { prisma } from "../lib/db";
import { hasAtLeast } from "../permissions/matrix";
import { POSITION_RU } from "../permissions/matrix";
import { listAchievements } from "../services/achievements";
import { userTestHistory } from "../services/tests";
import { DONE_STATUSES } from "../services/rules";
import { formatDateTime } from "../lib/time";

export const data = new SlashCommandBuilder()
  .setName("profile")
  .setDescription("Профиль сотрудника: участие в МП, достижения, статистика")
  .addUserOption((o) => o.setName("user").setDescription("Сотрудник (по умолчанию — вы)").setRequired(false));

export async function execute(interaction: ChatInputCommandInteraction, _client: Client): Promise<void> {
  const ctx = await commandContext(interaction);

  const userOption = interaction.options.getUser("user");
  const targetId = userOption?.id ?? ctx.userId;
  const isSelf = targetId === ctx.userId;

  if (!isSelf && !hasAtLeast(ctx.position, "ASSISTANT")) {
    throw new UserError("Профиль другого сотрудника доступен только сотрудникам отдела.");
  }

  const [dbUser, authored, organized, reports, achievements, warnings] = await Promise.all([
    prisma.user.findUnique({ where: { discordId: targetId } }),
    prisma.event.count({ where: { guildId: ctx.guildId, authorId: targetId } }),
    prisma.event.count({ where: { guildId: ctx.guildId, organizerId: targetId, status: { in: DONE_STATUSES } } }),
    prisma.eventReport.findMany({
      where: { createdById: targetId, event: { guildId: ctx.guildId } },
      select: { participantsActual: true },
    }),
    listAchievements(targetId),
    prisma.warning.count({ where: { userId: targetId, active: true } }),
  ]);

  const discordUser = userOption ?? interaction.user;
  const position = (dbUser?.position as string) ?? "GUEST";

  const participants = reports.reduce((sum, r) => sum + r.participantsActual, 0);
  const embed = baseEmbed(`👤 Профиль — ${discordUser.username}`).setColor(COLORS.BRAND);
  embed.setThumbnail(discordUser.displayAvatarURL());

  embed.addFields(
    { name: "Роль", value: POSITION_RU[position as keyof typeof POSITION_RU] ?? position, inline: true },
    { name: "В отделе с", value: dbUser ? formatDateTime(dbUser.joinedAt) : "—", inline: true },
    { name: "МП проведено", value: String(organized), inline: true },
    { name: "Заявок подано", value: String(authored), inline: true },
    { name: "Отчётов создано", value: String(reports.length), inline: true },
    { name: "Участников привлечено", value: String(participants), inline: true }
  );

  embed.addFields({
    name: "Достижения",
    value:
      achievements.length > 0
        ? achievements.map((a) => `${a.achievement.emoji} ${a.achievement.title}`).join("\n")
        : "Пока нет",
  });

  // Кадровые данные видны только тем, у кого есть права STATS_VIEW (Сотрудник+).
  if (hasAtLeast(ctx.position, "ASSISTANT")) {
    embed.addFields({ name: "Активные взыскания", value: String(warnings), inline: true });

    const attempts = await userTestHistory(targetId);
    embed.addFields({
      name: "Тесты",
      value:
        attempts.length > 0
          ? attempts
              .slice(0, 5)
              .map(
                (a) =>
                  `${a.passed ? "✅" : "❌"} ${a.test.title} — ${a.score ?? "—"}% (${a.finishedAt ? formatDateTime(a.finishedAt) : "—"})`
              )
              .join("\n")
          : "Попыток не было",
    });
  }

  embed.setFooter({ text: "Источник данных — база отдела" });
  await interaction.reply({ embeds: [withFooter(embed)], flags: MessageFlags.Ephemeral });
}
