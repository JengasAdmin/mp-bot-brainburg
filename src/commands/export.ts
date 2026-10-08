import {
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Client,
} from "discord.js";
import { commandContext, requirePermission } from "../interactions/shared";
import { exportStatsToCSV, exportStatsToPDF } from "../services/export";
import { writeFileSync } from "fs";
import { join } from "path";

export const data = new SlashCommandBuilder()
  .setName("export")
  .setDescription("Экспорт статистики в CSV/PDF")
  .addStringOption((o) =>
    o
      .setName("format")
      .setDescription("Формат экспорта")
      .setRequired(true)
      .addChoices(
        { name: "CSV", value: "csv" },
        { name: "PDF (текст)", value: "pdf" }
      )
  )
  .addStringOption((o) =>
    o
      .setName("period")
      .setDescription("Период")
      .setRequired(true)
      .addChoices(
        { name: "Сегодня", value: "today" },
        { name: "Неделя", value: "week" },
        { name: "Месяц", value: "month" },
        { name: "Год", value: "year" },
        { name: "Всё время", value: "all" }
      )
  );

export async function execute(interaction: ChatInputCommandInteraction, client: Client): Promise<void> {
  const ctx = await commandContext(interaction);
  await requirePermission(ctx, "STATS_VIEW");

  const format = interaction.options.getString("format", true) as "csv" | "pdf";
  const period = interaction.options.getString("period", true) as "today" | "week" | "month" | "year" | "all";

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    let content: string;
    let filename: string;
    let contentType: string;

    if (format === "csv") {
      content = await exportStatsToCSV(ctx.guildId, period);
      filename = `stats_${period}_${Date.now()}.csv`;
      contentType = "text/csv";
    } else {
      content = await exportStatsToPDF(ctx.guildId, period);
      filename = `stats_${period}_${Date.now()}.txt`;
      contentType = "text/plain";
    }

    // Сохраняем файл во временную директорию
    const filepath = join(process.cwd(), "temp", filename);
    writeFileSync(filepath, content, "utf-8");

    await interaction.editReply({
      content: `✅ Статистика экспортирована в формате ${format.toUpperCase()}`,
      files: [{ attachment: filepath, name: filename }],
    });
  } catch (err) {
    await interaction.editReply({
      content: "❌ Ошибка при экспорте статистики.",
    });
  }
}
