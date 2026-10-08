import { SlashCommandBuilder, type ChatInputCommandInteraction, type Client } from "discord.js";
import { commandContext, ephemeral, requirePermission } from "../interactions/shared";
import { infoEmbed, withFooter } from "../lib/embeds";
import { UserError } from "../lib/errors";
import { getFreeAt, getRotation, type RotationRow } from "../services/rotation";
import { formatDateTime, parseDateTime } from "../lib/time";
import { POSITION_RU } from "../permissions/matrix";

export const data = new SlashCommandBuilder()
  .setName("rotation")
  .setDescription("Ротация организаторов: кто давно не проводил МП и кто свободен в окно")
  .addIntegerOption((o) =>
    o.setName("days").setDescription("Порог «давно не проводил» в днях (по умолчанию 14)").setMinValue(1).setMaxValue(365)
  )
  .addStringOption((o) => o.setName("date").setDescription("Дата проверки занятости (ДД.ММ.ГГГГ)"))
  .addStringOption((o) => o.setName("time").setDescription("Время проверки (ЧЧ:ММ)"));

function idleLine(r: RotationRow): string {
  if (!r.lastEventAt) return "ещё не проводил МП";
  return `${r.idleDays} дн. назад — «${r.lastEventTitle}»`;
}

export async function execute(interaction: ChatInputCommandInteraction, _client: Client): Promise<void> {
  const ctx = await commandContext(interaction);
  await requirePermission(ctx, "STATS_VIEW");

  const days = interaction.options.getInteger("days") ?? 14;
  const dateStr = interaction.options.getString("date");
  const timeStr = interaction.options.getString("time");

  const rotation = await getRotation(ctx.guildId);
  if (rotation.length === 0) {
    throw new UserError("В отделе нет сотрудников с должностью организатора. Назначьте должности через /promote.");
  }

  const fields: { name: string; value: string; inline?: boolean }[] = [];

  // Опционально: свободные в указанное время (нет МП как организатора/автора).
  if (dateStr || timeStr) {
    if (!dateStr || !timeStr) throw new UserError("Для проверки занятости укажите и дату, и время.");
    const when = parseDateTime(dateStr, timeStr);
    const free = await getFreeAt(ctx.guildId, when, 60);
    fields.push({
      name: `🟢 Свободны ${formatDateTime(when)} (окно 60 мин)`,
      value: free.length > 0 ? free.slice(0, 25).map((r) => `<@${r.userId}>`).join(", ") : "Никто из организаторов не свободен в это время.",
    });
  }

  const overdue = rotation.filter((r) => r.idleDays >= days || !r.lastEventAt);
  fields.push({
    name: `⏳ Давно не проводили (порог ${days} дн.)`,
    value:
      overdue.length > 0
        ? overdue
            .slice(0, 15)
            .map((r) => `🟠 <@${r.userId}> — ${idleLine(r)}`)
            .join("\n")
        : "Все организаторы проводили МП недавно 👍",
  });

  fields.push({
    name: "📊 Все организаторы",
    value: rotation
      .slice(0, 20)
      .map((r) => {
        const mark = !r.lastEventAt ? "🔴" : r.idleDays >= days ? "🟠" : "🟢";
        return `${mark} <@${r.userId}> (${POSITION_RU[r.position as keyof typeof POSITION_RU] ?? r.position}) — ${idleLine(r)}`;
      })
      .join("\n")
      .slice(0, 1000),
  });

  await ephemeral(interaction, {
    embeds: [withFooter(infoEmbed("🔄 Ротация организаторов", undefined).addFields(fields))],
  });
}
