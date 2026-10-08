import { MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction, type Client } from "discord.js";
import { commandContext, ephemeral, requirePermission } from "../interactions/shared";
import { baseEmbed, COLORS, withFooter } from "../lib/embeds";
import { fetchAudit } from "../services/audit";
import { formatDateTime } from "../lib/time";
import { VIS_LEADERSHIP } from "./common";

export const data = new SlashCommandBuilder()
  .setName("logs")
  .setDescription("Журнал аудита: действия сотрудников и системы")
  .setDefaultMemberPermissions(VIS_LEADERSHIP)
  .addIntegerOption((o) => o.setName("limit").setDescription("Сколько записей (до 15)").setMinValue(1).setMaxValue(15))
  .addStringOption((o) =>
    o
      .setName("action")
      .setDescription("Фильтр по типу действия")
      .setRequired(false)
      .addChoices(
        { name: "Создание заявок", value: "EVENT_CREATED" },
        { name: "Одобрение", value: "EVENT_APPROVED" },
        { name: "Отклонение", value: "EVENT_REJECTED" },
        { name: "Доработка", value: "EVENT_REVISION" },
        { name: "Назначение организатора", value: "ORGANIZER_ASSIGNED" },
        { name: "Запуск МП", value: "EVENT_STARTED" },
        { name: "Завершение МП", value: "EVENT_FINISHED" },
        { name: "Отчёты", value: "EVENT_REPORTED" },
        { name: "Архивирование", value: "EVENT_ARCHIVED" },
        { name: "Кадровые решения", value: "POSITION_CHANGED" },
        { name: "Взыскания", value: "WARNING_ISSUED" },
        { name: "Тесты", value: "TEST_FINISHED" },
        { name: "Настройки", value: "SETUP_COMPLETED" }
      )
  );

export async function execute(interaction: ChatInputCommandInteraction, _client: Client): Promise<void> {
  const ctx = await commandContext(interaction);
  await requirePermission(ctx, "VIEW_LOGS");

  const limit = interaction.options.getInteger("limit") ?? 10;
  const action = interaction.options.getString("action");
  const rows = await fetchAudit(ctx.guildId, limit, action ?? undefined);

  const embed = baseEmbed(action ? `📜 Журнал аудита — ${action}` : "📜 Журнал аудита").setColor(COLORS.SURFACE);
  embed.setDescription(
    rows.length === 0
      ? "Записей нет."
      : rows
          .map((r) => {
            const who = r.actorId ? `<@${r.actorId}>` : "система";
            const change = r.oldValue || r.newValue ? ` — ${r.oldValue ?? "—"} → **${r.newValue ?? "—"}**` : "";
            const reason = r.reason ? `\n_Причина:_ ${r.reason}` : "";
            return `**${formatDateTime(r.createdAt)}** • ${who} • \`${r.action}\`${change}${reason}`;
          })
          .join("\n\n")
          .slice(0, 3900)
  );
  embed.setFooter({ text: `Показано ${rows.length} записей • Полная история — в БД` });

  await interaction.reply({ embeds: [withFooter(embed)], flags: MessageFlags.Ephemeral });
}
