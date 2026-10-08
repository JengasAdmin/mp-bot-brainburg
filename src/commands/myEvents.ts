import { MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction, type Client } from "discord.js";
import { commandContext } from "../interactions/shared";
import { prisma } from "../lib/db";
import { baseEmbed, COLORS, withFooter } from "../lib/embeds";
import { STATUS_RU } from "../constants";
import { formatDateTime, discordTimestamp } from "../lib/time";

export const data = new SlashCommandBuilder()
  .setName("my-events")
  .setDescription("Мои мероприятия: где я автор или организатор");

export async function execute(interaction: ChatInputCommandInteraction, _client: Client): Promise<void> {
  const ctx = await commandContext(interaction);

  const events = await prisma.event.findMany({
    where: { guildId: ctx.guildId, OR: [{ authorId: ctx.userId }, { organizerId: ctx.userId }] },
    orderBy: { scheduledAt: "desc" },
    take: 15,
    include: { category: true, report: true },
  });

  const embed = baseEmbed("📋 Мои мероприятия").setColor(COLORS.BRAND);
  embed.setDescription(
    events.length === 0
      ? "Вы ещё не участвовали в мероприятиях. Создайте заявку через `/create-event`."
      : events
          .map((e) => {
            const meta = STATUS_RU[e.status];
            const role = e.organizerId === ctx.userId ? "организатор" : "автор";
            return `${meta.emoji} \`${e.code}\` **${e.title}** — ${formatDateTime(e.scheduledAt)} — ${role}`;
          })
          .join("\n")
  );

  await interaction.reply({ embeds: [withFooter(embed)], flags: MessageFlags.Ephemeral });
}
