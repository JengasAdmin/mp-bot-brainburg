import { SlashCommandBuilder, type ChatInputCommandInteraction, type Client } from "discord.js";
import { MessageFlags } from "discord.js";
import { commandContext, requirePermission } from "../interactions/shared";
import { prisma } from "../lib/db";
import { baseEmbed, COLORS, withFooter } from "../lib/embeds";
import { STATUS_RU } from "../constants";
import { formatDateTime, discordTimestamp } from "../lib/time";
import { VIS_STAFF } from "./common";

export const data = new SlashCommandBuilder()
  .setName("events")
  .setDescription("Список мероприятий отдела с фильтром по статусу")
  .setDefaultMemberPermissions(VIS_STAFF)
  .addStringOption((o) =>
    o
      .setName("status")
      .setDescription("Фильтр по статусу")
      .setRequired(false)
      .addChoices(
        { name: "На проверке", value: "PENDING" },
        { name: "На доработке", value: "REVISION" },
        { name: "Одобрено", value: "APPROVED" },
        { name: "Запланировано", value: "PLANNED" },
        { name: "Проводится", value: "ACTIVE" },
        { name: "Завершено", value: "COMPLETED" },
        { name: "Отчёт сдан", value: "REPORTED" },
        { name: "В архиве", value: "ARCHIVED" },
        { name: "Отклонено", value: "REJECTED" },
        { name: "Отменено", value: "CANCELLED" }
      )
  )
  .addIntegerOption((o) => o.setName("limit").setDescription("Сколько показать (по умолчанию 10)").setMinValue(1).setMaxValue(25));

export async function execute(interaction: ChatInputCommandInteraction, _client: Client): Promise<void> {
  const ctx = await commandContext(interaction);
  await requirePermission(ctx, "STATS_VIEW");

  const status = interaction.options.getString("status");
  const limit = interaction.options.getInteger("limit") ?? 10;

  const where = { guildId: ctx.guildId, ...(status ? { status } : {}) };
  const [events, total] = await Promise.all([
    prisma.event.findMany({
      where,
      orderBy: { scheduledAt: status ? "asc" : "desc" },
      take: limit,
      include: { category: true, report: true },
    }),
    prisma.event.count({ where }),
  ]);

  const embed = baseEmbed(status ? `📋 Мероприятия — ${STATUS_RU[status]?.label ?? status}` : "📋 Мероприятия")
    .setColor(COLORS.INFO);

  embed.setDescription(
    events.length === 0
      ? "Мероприятий не найдено."
      : events
          .map((e) => {
            const meta = STATUS_RU[e.status];
            const owner = e.organizerId ?? e.authorId;
            return `${meta.emoji} \`${e.code}\` **${e.title}** — ${formatDateTime(e.scheduledAt)} (${discordTimestamp(e.scheduledAt, "R")}) — <@${owner}>`;
          })
          .join("\n")
  );
  embed.setFooter({ text: `Показано ${events.length} из ${total} • Используйте /event для деталей` });

  await interaction.reply({ embeds: [withFooter(embed)], flags: MessageFlags.Ephemeral });
}
