import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Client,
} from "discord.js";
import { UserError } from "../lib/errors";
import { baseEmbed, infoEmbed, withFooter, COLORS } from "../lib/embeds";
import { hasPermission, describePermission } from "../permissions/matrix";
import { describeReport, performSetup } from "../discord/setupService";
import { writeAudit } from "../services/audit";
import { updatePlanningBoard, updateActiveBoard, updateStatsBoard } from "../services/events";
import { achievementsBoardEmbed } from "../services/achievements";
import { rosterEmbed, internshipsEmbed } from "../services/personnel";
import { logger } from "../lib/logger";

export const data = new SlashCommandBuilder()
  .setName("setup")
  .setDescription("Первоначальная настройка сервера отдела (роли, каналы, права). Идемпотентна.");

export async function execute(interaction: ChatInputCommandInteraction, client: Client): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const guild = interaction.guild;
  if (!guild) throw new UserError("Команда доступна только на сервере.");

  // Определяем позицию вызывающего по факту: владелец или полные права.
  const member = await guild.members.fetch(interaction.user.id);
  const isAdmin = member.permissions.has(PermissionFlagsBits.Administrator) || member.id === guild.ownerId;
  if (!hasPermission(isAdmin ? "ADMIN" : "GUEST", "SETUP")) {
    throw new UserError(`Настройка сервера доступна только Главной Администрации. ${describePermission("SETUP")}`);
  }

  const me = guild.members.me;
  if (!me) throw new UserError("Бот не виден на сервере.");
  const missing = [PermissionFlagsBits.ManageRoles, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageWebhooks].filter(
    (p) => !me.permissions.has(p)
  );
  if (missing.length > 0) {
    throw new UserError("У бота не хватает прав: «Управление ролями» и/или «Управление каналами». Выдайте их и повторите /setup.");
  }

  await interaction.editReply({ embeds: [infoEmbed("⚙️ Настройка сервера", "Выполняется… Создаю роли и каналы. Это может занять до минуты.")] });

  const report = await performSetup(guild, { createMissing: true, syncPermissions: true });

  const freshSettings = await import("../services/settings").then((m) => m.getSettings(guild.id));
  if (report.errors.length > 0 && freshSettings.reviewChannelId === null) {
    // Настройка не завершена — панели не публикуем, чтобы не потерять сообщения.
    logger.warn("Настройка завершилась с ошибками:", report.errors);
  }

  await postPanels(client, guild, {
    applicationsChannelId: freshSettings.applicationsChannelId,
    ideasChannelId: freshSettings.ideasChannelId,
    reviewChannelId: freshSettings.reviewChannelId,
    testingChannelId: freshSettings.testingChannelId,
    achievementsChannelId: freshSettings.achievementsChannelId,
    rosterChannelId: freshSettings.rosterChannelId,
    internshipChannelId: freshSettings.internshipChannelId,
    statsChannelId: freshSettings.statsChannelId,
    activeChannelId: freshSettings.activeChannelId,
    planningChannelId: freshSettings.planningChannelId,
  });

  await writeAudit(client, {
    guildId: guild.id,
    action: "SETUP_COMPLETED",
    actorId: interaction.user.id,
    actorTag: interaction.user.tag,
    targetType: "guild",
    targetId: guild.id,
    newValue: describeReport(report),
  });

  const embed = baseEmbed(
    report.errors.length > 0 ? "⚙️ Настройка сервера завершена с ошибками" : "⚙️ Настройка сервера завершена"
  )
    .setColor(report.errors.length > 0 ? COLORS.WARNING : COLORS.SUCCESS)
    .setDescription(
      "Структура сервера актуальна (дубликаты не создаются, права пересинхронизированы).\n\n" +
        "Дальше: назначьте должности через /promote, добавьте вопросы тестов через /test create и /test question."
    )
    .addFields({ name: "Итог", value: describeReport(report).slice(0, 1000) || "—" });

  await interaction.editReply({ embeds: [withFooter(embed)] });
}

/// Публикует стартовые панели (идемпотентно — сообщения-борды апсертятся,
/// кнопочные панели дублируются только при отсутствии закреплённых аналогов).
async function postPanels(
  client: Client,
  guild: import("discord.js").Guild,
  channels: Record<string, string | null>
) {
  /// marker — по чему узнаём «эта же панель уже опубликована»:
  /// кнопка (customId) либо заголовок эмбеда.
  const send = async (
    channelId: string | null | undefined,
    payload: { embeds: unknown[]; components?: unknown[] },
    marker: { button?: string; title?: string }
  ) => {
    if (!channelId) return;
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (channel?.type !== ChannelType.GuildText) return;

    // Идемпотентность: повторный /setup не должен дублировать панели.
    try {
      const botId = client.user?.id;
      const recent = await channel.messages.fetch({ limit: 50 });
      const rowCustomIds = (row: unknown): string[] => {
        if (!row || typeof row !== "object" || !("components" in row)) return [];
        return ((row as { components: unknown[] }).components ?? []).flatMap((c) => {
          if (c && typeof c === "object" && "customId" in c) {
            const id = (c as { customId?: unknown }).customId;
            return typeof id === "string" ? [id] : [];
          }
          return [];
        });
      };
      const duplicate = recent.some(
        (m) =>
          m.author.id === botId &&
          (marker.button
            ? m.components.some((row) => rowCustomIds(row).includes(marker.button!))
            : m.embeds.some((e) => e.title === marker.title))
      );
      if (duplicate) return;
    } catch {
      // Не удалось проверить историю — отправляем (лучше дубль, чем потерянная панель).
    }

    // @ts-expect-error — payload валиден для TextChannel.send
    await channel.send(payload).catch((err: unknown) => logger.warn(`Панель не отправлена в ${channelId}:`, err));
  };

  await send(
    channels.applicationsChannelId,
    {
      embeds: [
        withFooter(
          infoEmbed(
            "📝 Подача заявок на МП",
            "Нажмите кнопку ниже и заполните форму. Заявка автоматически получит уникальный ID и попадёт на проверку руководству.\n\n**Правила:** одна заявка — одно мероприятие. После доработки заявку можно отправить повторно."
          )
        ),
      ],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId("app:create").setLabel("Создать МП").setEmoji("📝").setStyle(ButtonStyle.Primary)
        ),
      ],
    },
    { button: "app:create" }
  );

  await send(
    channels.ideasChannelId,
    {
      embeds: [
        withFooter(infoEmbed("💡 Идеи мероприятий", "Есть идея для МП? Оформите её через кнопку — она пройдёт тот же цикл согласования.")),
      ],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId("app:create").setLabel("Создать заявку").setEmoji("📝").setStyle(ButtonStyle.Primary)
        ),
      ],
    },
    { button: "app:create" }
  );

  await send(
    channels.reviewChannelId,
    {
      embeds: [
        withFooter(
          infoEmbed(
            "🔍 Очередь проверки",
            "Сюда автоматически поступают новые заявки с кнопками одобрения, доработки, отклонения и назначения организатора."
          )
        ),
      ],
    },
    { title: "🔍 Очередь проверки" }
  );

  await send(
    channels.testingChannelId,
    {
      embeds: [
        withFooter(
          infoEmbed(
            "🎓 Тестирование",
            "Проверьте знания регламента. Прохождение — в личных сообщениях с ботом. Количество попыток ограничено. Список тестов: `/test start`."
          )
        ),
      ],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId("tst:start").setLabel("Начать тест").setEmoji("📝").setStyle(ButtonStyle.Primary)
        ),
      ],
    },
    { button: "tst:start" }
  );

  await updatePlanningBoard(client, guild.id);
  await updateActiveBoard(client, guild.id);
  await updateStatsBoard(client, guild.id, guild.name);

  await send(channels.achievementsChannelId, { embeds: [await achievementsBoardEmbed()] }, { title: "🏆 Достижения отдела" });
  await send(channels.rosterChannelId, { embeds: [await rosterEmbed(guild)] }, { title: "👤 Состав отдела организаторов" });
  await send(channels.internshipChannelId, { embeds: [await internshipsEmbed(guild.id)] }, { title: "📝 Активные стажировки" });
}
