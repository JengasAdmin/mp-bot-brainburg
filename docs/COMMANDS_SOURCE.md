# Исходники всех команд бота (снимок от 2026-10-08 23:35)

> Сгенерировано из `src/commands/`. **Источник истины — файлы в `src/commands/`**, этот файл — снимок для чтения/печати.

---

## `src/commands/setup.ts`

```typescript
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

```

---

## `src/commands/profile.ts`

```typescript
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

```

---

## `src/commands/stats.ts`

```typescript
import {
  ActionRowBuilder,
  MessageFlags,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type ChatInputCommandInteraction,
  type Client,
} from "discord.js";
import { commandContext, ephemeral, requirePermission } from "../interactions/shared";
import { withFooter } from "../lib/embeds";
import { statsEmbed } from "../services/stats";
import { STATS_PERIOD_RU, type StatsPeriod } from "../services/rules";

export const data = new SlashCommandBuilder()
  .setName("stats")
  .setDescription("Статистика отдела: мероприятия, участники, категории, организаторы")
  .addStringOption((o) =>
    o
      .setName("period")
      .setDescription("Период")
      .setRequired(false)
      .addChoices(
        { name: "Сегодня", value: "today" },
        { name: "Неделя", value: "week" },
        { name: "Месяц", value: "month" },
        { name: "Год", value: "year" },
        { name: "Всё время", value: "all" }
      )
  );

export function periodSelectRow(selected: StatsPeriod): ActionRowBuilder<StringSelectMenuBuilder> {
  const menu = new StringSelectMenuBuilder()
    .setCustomId("sel:stats")
    .setPlaceholder(`Период: ${STATS_PERIOD_RU[selected]}`)
    .addOptions(
      (Object.keys(STATS_PERIOD_RU) as StatsPeriod[]).map((p) =>
        new StringSelectMenuOptionBuilder().setLabel(STATS_PERIOD_RU[p]).setValue(p)
      )
    );
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

export async function execute(interaction: ChatInputCommandInteraction, client: Client): Promise<void> {
  const ctx = await commandContext(interaction);
  await requirePermission(ctx, "STATS_VIEW");

  const period = (interaction.options.getString("period") as StatsPeriod | null) ?? "all";
  const embed = await statsEmbed(ctx.guildId, interaction.guild?.name ?? "Отдел", period);

  await interaction.reply({
    embeds: [withFooter(embed)],
    components: [periodSelectRow(period)],
    flags: MessageFlags.Ephemeral,
  });
}

```

---

## `src/commands/logs.ts`

```typescript
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

```

---

## `src/commands/export.ts`

```typescript
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

```

---

## `src/commands/createEvent.ts`

```typescript
import { SlashCommandBuilder, type ChatInputCommandInteraction, type Client } from "discord.js";
import { commandContext, requirePermission } from "../interactions/shared";
import { showCategorySelect } from "../interactions/buttons";
import { VIS_STAFF } from "./common";

export const data = new SlashCommandBuilder()
  .setName("create-event")
  .setDescription("Подать заявку на проведение МП (откроется форма)")
  .setDefaultMemberPermissions(VIS_STAFF);

export async function execute(interaction: ChatInputCommandInteraction, _client: Client): Promise<void> {
  const ctx = await commandContext(interaction);
  await requirePermission(ctx, "CREATE_APPLICATION");
  await showCategorySelect(interaction);
}

```

---

## `src/commands/events.ts`

```typescript
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

```

---

## `src/commands/myEvents.ts`

```typescript
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

```

---

## `src/commands/event.ts`

```typescript
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Client,
} from "discord.js";
import { commandContext, ephemeral } from "../interactions/shared";
import { UserError } from "../lib/errors";
import { withFooter } from "../lib/embeds";
import { hasAtLeast } from "../permissions/matrix";
import { buildEventComponents, buildEventEmbed, buildReviewComponents, buildReviewEmbed } from "../services/events";
import { STATUS } from "../constants";
import { autocompleteEvents, eventFromOption } from "./common";

export const data = new SlashCommandBuilder()
  .setName("event")
  .setDescription("Карточка мероприятия по коду (MP-0001)")
  .addStringOption((o) =>
    o.setName("event").setDescription("Код мероприятия").setRequired(true).setAutocomplete(true)
  );

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  await autocompleteEvents(interaction);
}

export async function execute(interaction: ChatInputCommandInteraction, _client: Client): Promise<void> {
  const ctx = await commandContext(interaction);
  const event = await eventFromOption(interaction);

  const isStaff = hasAtLeast(ctx.position, "ASSISTANT");
  const isMine = ctx.userId === event.authorId || ctx.userId === event.organizerId;
  if (!isStaff && !isMine) {
    throw new UserError("Посмотреть карточку может автор, организатор или сотрудник отдела.");
  }

  const reviewable = [STATUS.PENDING, STATUS.REVISION].includes(event.status as never);
  const embed = reviewable ? buildReviewEmbed(event) : buildEventEmbed(event);
  const components = reviewable
    ? buildReviewComponents(event)
    : buildEventComponents(event);

  if (isStaff || isMine) {
    components.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`ev:history:${event.id}`)
          .setLabel("История статусов")
          .setEmoji("🕒")
          .setStyle(ButtonStyle.Secondary)
      )
    );
  }

  if (components.length === 0) {
    await ephemeral(interaction, { embeds: [withFooter(embed)] });
    return;
  }

  await interaction.reply({
    embeds: [withFooter(embed)],
    components,
    flags: MessageFlags.Ephemeral,
  });
}

```

---

## `src/commands/editEvent.ts`

```typescript
import { SlashCommandBuilder, type ChatInputCommandInteraction, type Client } from "discord.js";
import { commandContext, requirePermission } from "../interactions/shared";
import { UserError } from "../lib/errors";
import { hasAtLeast } from "../permissions/matrix";
import { STATUS_RU } from "../constants";
import { editModal } from "../interactions/buttons";
import { VIS_STAFF, eventFromOption } from "./common";
import { EDITABLE_STATUSES } from "../services/rules";

export const data = new SlashCommandBuilder()
  .setName("edit-event")
  .setDescription("Редактировать заявку на МП (откроется форма)")
  .setDefaultMemberPermissions(VIS_STAFF)
  .addStringOption((o) =>
    o.setName("event").setDescription("Код мероприятия").setRequired(true).setAutocomplete(true)
  );

export async function execute(interaction: ChatInputCommandInteraction, _client: Client): Promise<void> {
  const ctx = await commandContext(interaction);
  const event = await eventFromOption(interaction);

  if (event.authorId !== ctx.userId) {
    await requirePermission(ctx, "EDIT_ANY_EVENT");
  } else if (!hasAtLeast(ctx.position, "ASSISTANT")) {
    throw new UserError("Редактировать заявку может только её автор или руководство.");
  }

  if (!EDITABLE_STATUSES.includes(event.status)) {
    throw new UserError(
      `Заявка в статусе «${STATUS_RU[event.status]?.label ?? event.status}» не редактируется.`
    );
  }

  await interaction.showModal(editModal(event.id, event));
}

```

---

## `src/commands/approve.ts`

```typescript
import { SlashCommandBuilder, type ChatInputCommandInteraction, type Client } from "discord.js";
import { commandContext, ephemeral, requirePermission } from "../interactions/shared";
import { UserError } from "../lib/errors";
import { successEmbed, withFooter } from "../lib/embeds";
import { approveEvent } from "../services/events";
import { STATUS, STATUS_RU } from "../constants";
import { VIS_STAFF, eventFromOption } from "./common";

export const data = new SlashCommandBuilder()
  .setName("approve")
  .setDescription("Одобрить заявку на МП: она уйдёт в планирование")
  .setDefaultMemberPermissions(VIS_STAFF)
  .addStringOption((o) => o.setName("event").setDescription("Код мероприятия").setRequired(true).setAutocomplete(true));

export async function execute(interaction: ChatInputCommandInteraction, client: Client): Promise<void> {
  const ctx = await commandContext(interaction);
  await requirePermission(ctx, "REVIEW");
  const event = await eventFromOption(interaction);

  if (event.status !== STATUS.PENDING && event.status !== STATUS.REVISION) {
    throw new UserError(`Заявка уже обработана (статус: ${STATUS_RU[event.status]?.label ?? event.status}).`);
  }

  const updated = await approveEvent(client, event, interaction.user);

  await ephemeral(interaction, {
    embeds: [
      withFooter(
        successEmbed(
          "✅ Заявка одобрена",
          `\`${updated.code}\` «${updated.title}» → **${STATUS_RU[STATUS.PLANNED].label}**.\n` +
            `Канал МП${updated.eventChannelId ? ` <#${updated.eventChannelId}>` : ""} и голосовой канал созданы. Автор уведомлён.`
        )
      ),
    ],
  });
}

```

---

## `src/commands/reject.ts`

```typescript
import { SlashCommandBuilder, type ChatInputCommandInteraction, type Client } from "discord.js";
import { commandContext, ephemeral, requirePermission } from "../interactions/shared";
import { UserError } from "../lib/errors";
import { successEmbed, withFooter } from "../lib/embeds";
import { rejectEvent } from "../services/events";
import { STATUS, STATUS_RU } from "../constants";
import { VIS_STAFF, eventFromOption } from "./common";

export const data = new SlashCommandBuilder()
  .setName("reject")
  .setDescription("Отклонить заявку на МП с указанием причины")
  .setDefaultMemberPermissions(VIS_STAFF)
  .addStringOption((o) => o.setName("event").setDescription("Код мероприятия").setRequired(true).setAutocomplete(true))
  .addStringOption((o) =>
    o.setName("reason").setDescription("Причина отклонения (отправится автору)").setRequired(true).setMaxLength(900)
  );

export async function execute(interaction: ChatInputCommandInteraction, client: Client): Promise<void> {
  const ctx = await commandContext(interaction);
  await requirePermission(ctx, "REVIEW");
  const event = await eventFromOption(interaction);

  if (event.status !== STATUS.PENDING && event.status !== STATUS.REVISION) {
    throw new UserError(`Заявка уже обработана (статус: ${STATUS_RU[event.status]?.label ?? event.status}).`);
  }

  const reason = interaction.options.getString("reason", true).trim();
  if (reason.length < 5) throw new UserError("Причина слишком короткая (минимум 5 символов).");

  const updated = await rejectEvent(client, event, interaction.user, reason);

  await ephemeral(interaction, {
    embeds: [withFooter(successEmbed("❌ Заявка отклонена", `\`${updated.code}\` — статус «${STATUS_RU[STATUS.REJECTED].label}». Автор уведомлён.`))],
  });
}

```

---

## `src/commands/requestRevision.ts`

```typescript
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

```

---

## `src/commands/assign.ts`

```typescript
import { SlashCommandBuilder, type AutocompleteInteraction, type ChatInputCommandInteraction, type Client } from "discord.js";
import { commandContext, ephemeral, requirePermission } from "../interactions/shared";
import { UserError } from "../lib/errors";
import { successEmbed, withFooter } from "../lib/embeds";
import { assignOrganizer } from "../services/events";
import { prisma } from "../lib/db";
import { hasAtLeast, type Position } from "../permissions/matrix";
import { VIS_STAFF, autocompleteEvents, autocompleteStaff, eventFromOption } from "./common";

export const data = new SlashCommandBuilder()
  .setName("assign")
  .setDescription("Назначить организатора мероприятия")
  .setDefaultMemberPermissions(VIS_STAFF)
  .addStringOption((o) => o.setName("event").setDescription("Код мероприятия").setRequired(true).setAutocomplete(true))
  .addStringOption((o) =>
    o.setName("organizer").setDescription("Сотрудник (из базы отдела)").setRequired(true).setAutocomplete(true)
  );

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused(true);
  if (focused.name === "event") return autocompleteEvents(interaction);
  return autocompleteStaff(interaction, "ASSISTANT");
}

export async function execute(interaction: ChatInputCommandInteraction, client: Client): Promise<void> {
  const ctx = await commandContext(interaction);
  await requirePermission(ctx, "ASSIGN");

  const event = await eventFromOption(interaction);
  const organizerId = interaction.options.getString("organizer", true).trim();

  const target = await prisma.user.findUnique({ where: { discordId: organizerId } });
  if (!target || target.leftAt) {
    throw new UserError("Сотрудник не найден в базе отдела. Сначала назначьте должность через /promote.");
  }
  const position = target.position as Position;
  if (!hasAtLeast(position, "ASSISTANT")) {
    throw new UserError("Назначить организатором можно только сотрудника отдела (Помощник Организаторов и выше).");
  }

  const updated = await assignOrganizer(client, event, interaction.user, organizerId);

  await ephemeral(interaction, {
    embeds: [withFooter(successEmbed("👤 Организатор назначен", `\`${updated.code}\` → <@${organizerId}>. Сотрудник уведомлён в ЛС.`))],
  });
}

```

---

## `src/commands/startEvent.ts`

```typescript
import { SlashCommandBuilder, type ChatInputCommandInteraction, type Client } from "discord.js";
import { commandContext, ephemeral } from "../interactions/shared";
import { successEmbed, withFooter } from "../lib/embeds";
import { startEvent } from "../services/events";
import { STATUS_RU } from "../constants";
import { assertCanManageEvent, eventFromOption } from "./common";

export const data = new SlashCommandBuilder()
  .setName("start-event")
  .setDescription("Начать проведение МП (создаёт каналы, если их нет)")
  .addStringOption((o) => o.setName("event").setDescription("Код мероприятия").setRequired(true).setAutocomplete(true));

export async function execute(interaction: ChatInputCommandInteraction, client: Client): Promise<void> {
  const ctx = await commandContext(interaction);
  const event = await eventFromOption(interaction);
  assertCanManageEvent(ctx, event);

  const updated = await startEvent(client, event, interaction.user);

  await ephemeral(interaction, {
    embeds: [
      withFooter(
        successEmbed(
          "▶️ МП запущено",
          `\`${updated.code}\` «${updated.title}» → «${STATUS_RU[updated.status].label}».` +
            `${updated.eventChannelId ? `\nКанал: <#${updated.eventChannelId}>` : ""}`
        )
      ),
    ],
  });
}

```

---

## `src/commands/finishEvent.ts`

```typescript
import { SlashCommandBuilder, type ChatInputCommandInteraction, type Client } from "discord.js";
import { commandContext, ephemeral } from "../interactions/shared";
import { successEmbed, withFooter } from "../lib/embeds";
import { finishEvent } from "../services/events";
import { STATUS_RU } from "../constants";
import { assertCanManageEvent, eventFromOption } from "./common";

export const data = new SlashCommandBuilder()
  .setName("finish-event")
  .setDescription("Завершить проведение МП и запросить отчёт")
  .addStringOption((o) => o.setName("event").setDescription("Код мероприятия").setRequired(true).setAutocomplete(true));

export async function execute(interaction: ChatInputCommandInteraction, client: Client): Promise<void> {
  const ctx = await commandContext(interaction);
  const event = await eventFromOption(interaction);
  assertCanManageEvent(ctx, event);

  const updated = await finishEvent(client, event, interaction.user);

  await ephemeral(interaction, {
    embeds: [
      withFooter(
        successEmbed(
          "🏁 МП завершено",
          `\`${updated.code}\` → «${STATUS_RU[updated.status].label}».\nТеперь создайте отчёт: \`/report event:${updated.code}\`.`
        )
      ),
    ],
  });
}

```

---

## `src/commands/report.ts`

```typescript
import { SlashCommandBuilder, type ChatInputCommandInteraction, type Client } from "discord.js";
import { commandContext } from "../interactions/shared";
import { UserError } from "../lib/errors";
import { reportModal } from "../interactions/buttons";
import { STATUS_RU } from "../constants";
import { assertCanManageEvent, eventFromOption } from "./common";

export const data = new SlashCommandBuilder()
  .setName("report")
  .setDescription("Создать отчёт по завершённому МП")
  .addStringOption((o) => o.setName("event").setDescription("Код мероприятия").setRequired(true).setAutocomplete(true));

export async function execute(interaction: ChatInputCommandInteraction, _client: Client): Promise<void> {
  const ctx = await commandContext(interaction);
  const event = await eventFromOption(interaction);
  assertCanManageEvent(ctx, event);

  if (event.status !== "COMPLETED") {
    throw new UserError(`Отчёт создаётся после завершения МП (сейчас: ${STATUS_RU[event.status]?.label ?? event.status}).`);
  }
  if (event.report) throw new UserError(`Отчёт по ${event.code} уже сдан.`);

  await interaction.showModal(reportModal(event.id));
}

```

---

## `src/commands/archive.ts`

```typescript
import { SlashCommandBuilder, type ChatInputCommandInteraction, type Client } from "discord.js";
import { commandContext, ephemeral, requirePermission } from "../interactions/shared";
import { successEmbed, withFooter } from "../lib/embeds";
import { archiveEvent } from "../services/events";
import { VIS_LEADERSHIP, eventFromOption } from "./common";

export const data = new SlashCommandBuilder()
  .setName("archive")
  .setDescription("Заархивировать мероприятие после сдачи отчёта (данные сохраняются)")
  .setDefaultMemberPermissions(VIS_LEADERSHIP)
  .addStringOption((o) => o.setName("event").setDescription("Код мероприятия").setRequired(true).setAutocomplete(true));

export async function execute(interaction: ChatInputCommandInteraction, client: Client): Promise<void> {
  const ctx = await commandContext(interaction);
  await requirePermission(ctx, "ARCHIVE");
  const event = await eventFromOption(interaction);

  const updated = await archiveEvent(client, event, interaction.user);

  await ephemeral(interaction, {
    embeds: [
      withFooter(
        successEmbed(
          "🗃️ Мероприятие заархивировано",
          `\`${updated.code}\` «${updated.title}» закрыто. Заявка, история статусов, отчёт и участники сохранены в БД.`
        )
      ),
    ],
  });
}

```

---

## `src/commands/cancelEvent.ts`

```typescript
import { SlashCommandBuilder, type ChatInputCommandInteraction, type Client } from "discord.js";
import { commandContext, ephemeral, requirePermission } from "../interactions/shared";
import { UserError } from "../lib/errors";
import { successEmbed, withFooter } from "../lib/embeds";
import { cancelEvent } from "../services/events";
import { STATUS_RU } from "../constants";
import { eventFromOption } from "./common";

export const data = new SlashCommandBuilder()
  .setName("cancel-event")
  .setDescription("Отменить мероприятие с указанием причины")
  .addStringOption((o) => o.setName("event").setDescription("Код мероприятия").setRequired(true).setAutocomplete(true))
  .addStringOption((o) =>
    o.setName("reason").setDescription("Причина отмены (будет видна автору)").setRequired(true).setMaxLength(500)
  );

export async function execute(interaction: ChatInputCommandInteraction, client: Client): Promise<void> {
  const ctx = await commandContext(interaction);
  const event = await eventFromOption(interaction);

  if (event.authorId !== ctx.userId && event.organizerId !== ctx.userId) {
    await requirePermission(ctx, "REVIEW");
  }

  const reason = interaction.options.getString("reason", true).trim();
  if (reason.length < 5) throw new UserError("Причина слишком короткая (минимум 5 символов).");

  const updated = await cancelEvent(client, event, interaction.user, reason);

  await ephemeral(interaction, {
    embeds: [
      withFooter(
        successEmbed(
          "🚫 Мероприятие отменено",
          `\`${updated.code}\` «${updated.title}» — статус «${STATUS_RU[updated.status].label}». Автор уведомлён.`
        )
      ),
    ],
  });
}

```

---

## `src/commands/calendar.ts`

```typescript
import {
  ActionRowBuilder,
  MessageFlags,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type ChatInputCommandInteraction,
  type Client,
} from "discord.js";
import { commandContext, ephemeral, requirePermission } from "../interactions/shared";
import { withFooter } from "../lib/embeds";
import { getWeeklyCalendar, buildCalendarEmbed, type CalendarFilters } from "../services/calendar";
import { prisma } from "../lib/db";

export const data = new SlashCommandBuilder()
  .setName("calendar")
  .setDescription("Календарь мероприятий на неделю")
  .addIntegerOption((o) =>
    o.setName("category_id").setDescription("Фильтр по категории (ID)").setRequired(false)
  )
  .addUserOption((o) =>
    o.setName("organizer").setDescription("Фильтр по организатору").setRequired(false)
  );

export async function execute(interaction: ChatInputCommandInteraction, client: Client): Promise<void> {
  const ctx = await commandContext(interaction);
  await requirePermission(ctx, "STATS_VIEW");

  const categoryId = interaction.options.getInteger("category_id") ?? undefined;
  const organizer = interaction.options.getUser("organizer") ?? undefined;

  const filters: CalendarFilters = {
    categoryId,
    organizerId: organizer?.id,
  };

  const events = await getWeeklyCalendar(ctx.guildId, filters);
  const embed = buildCalendarEmbed(events, interaction.guild?.name ?? "Отдел", filters);

  await interaction.reply({
    embeds: [withFooter(embed)],
    flags: MessageFlags.Ephemeral,
  });
}

```

---

## `src/commands/promote.ts`

```typescript
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

```

---

## `src/commands/warning.ts`

```typescript
import { SlashCommandBuilder, type ChatInputCommandInteraction, type Client } from "discord.js";
import { commandContext, ephemeral, requirePermission } from "../interactions/shared";
import { UserError } from "../lib/errors";
import { warnEmbed, withFooter } from "../lib/embeds";
import { issueSanction } from "../services/personnel";
import { VIS_STAFF } from "./common";
import { formatDateTime } from "../lib/time";

export const data = new SlashCommandBuilder()
  .setName("warning")
  .setDescription("Выдать предупреждение сотруднику (фиксируется в журнале)")
  .setDefaultMemberPermissions(VIS_STAFF)
  .addUserOption((o) => o.setName("user").setDescription("Сотрудник").setRequired(true))
  .addStringOption((o) => o.setName("reason").setDescription("Причина").setRequired(true).setMaxLength(500))
  .addIntegerOption((o) =>
    o.setName("days").setDescription("Срок действия в днях (по умолчанию — бессрочно)").setMinValue(1).setMaxValue(365)
  );

export async function execute(interaction: ChatInputCommandInteraction, client: Client): Promise<void> {
  const ctx = await commandContext(interaction);
  await requirePermission(ctx, "WARN");

  const target = interaction.options.getUser("user", true);
  if (target.bot) throw new UserError("Ботам взыскания не выдаются.");
  const reason = interaction.options.getString("reason", true).trim();
  if (reason.length < 5) throw new UserError("Причина слишком короткая (минимум 5 символов).");

  const days = interaction.options.getInteger("days");
  const expiresAt = days ? new Date(Date.now() + days * 24 * 3600_000) : null;

  await issueSanction(client, ctx.guildId, target.id, "WARNING", reason, interaction.user, expiresAt);

  await ephemeral(interaction, {
    embeds: [
      withFooter(
        warnEmbed(
          "⚠️ Предупреждение выдано",
          `Сотрудник: <@${target.id}>\nПричина: ${reason}\n${expiresAt ? `Действует до: ${formatDateTime(expiresAt)}` : "Срок: бессрочно"}`
        )
      ),
    ],
  });
}

```

---

## `src/commands/reprimand.ts`

```typescript
import { SlashCommandBuilder, type ChatInputCommandInteraction, type Client } from "discord.js";
import { commandContext, ephemeral, requirePermission } from "../interactions/shared";
import { UserError } from "../lib/errors";
import { warnEmbed, withFooter } from "../lib/embeds";
import { issueSanction } from "../services/personnel";
import { VIS_STAFF } from "./common";

export const data = new SlashCommandBuilder()
  .setName("reprimand")
  .setDescription("Выдать выговор сотруднику (фиксируется в журнале)")
  .setDefaultMemberPermissions(VIS_STAFF)
  .addUserOption((o) => o.setName("user").setDescription("Сотрудник").setRequired(true))
  .addStringOption((o) => o.setName("reason").setDescription("Причина").setRequired(true).setMaxLength(500));

export async function execute(interaction: ChatInputCommandInteraction, client: Client): Promise<void> {
  const ctx = await commandContext(interaction);
  await requirePermission(ctx, "WARN");

  const target = interaction.options.getUser("user", true);
  if (target.bot) throw new UserError("Ботам взыскания не выдаются.");
  const reason = interaction.options.getString("reason", true).trim();
  if (reason.length < 5) throw new UserError("Причина слишком короткая (минимум 5 символов).");

  await issueSanction(client, ctx.guildId, target.id, "REPRIMAND", reason, interaction.user);

  await ephemeral(interaction, {
    embeds: [withFooter(warnEmbed("🚫 Выговор выдан", `Сотрудник: <@${target.id}>\nПричина: ${reason}`))],
  });
}

```

---

## `src/commands/discipline.ts`

```typescript
import { MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction, type Client } from "discord.js";
import { commandContext, ephemeral, requirePermission } from "../interactions/shared";
import { successEmbed, withFooter } from "../lib/embeds";
import { removeSanction, sanctionsBoardEmbed } from "../services/personnel";
import { VIS_STAFF } from "./common";

export const data = new SlashCommandBuilder()
  .setName("discipline")
  .setDescription("Дисциплина: активные взыскания и их снятие")
  .setDefaultMemberPermissions(VIS_STAFF)
  .addSubcommand((sc) => sc.setName("list").setDescription("Показать активные взыскания"))
  .addSubcommand((sc) =>
    sc
      .setName("remove")
      .setDescription("Снять взыскание")
      .addIntegerOption((o) => o.setName("id").setDescription("ID взыскания (из /discipline list)").setRequired(true).setMinValue(1))
      .addStringOption((o) => o.setName("reason").setDescription("Причина снятия").setMaxLength(500))
  );

export async function execute(interaction: ChatInputCommandInteraction, client: Client): Promise<void> {
  const ctx = await commandContext(interaction);
  await requirePermission(ctx, "WARN");

  const sub = interaction.options.getSubcommand();
  if (sub === "list") {
    const embed = await sanctionsBoardEmbed(ctx.guildId);
    await interaction.reply({ embeds: [withFooter(embed)], flags: MessageFlags.Ephemeral });
    return;
  }

  const id = interaction.options.getInteger("id", true);
  const reason = interaction.options.getString("reason")?.trim();
  await removeSanction(client, ctx.guildId, id, interaction.user, reason);

  await ephemeral(interaction, {
    embeds: [withFooter(successEmbed("✅ Взыскание снято", `Взыскание #${id} снято. Изменение записано в журнал.`))],
  });
}

```

---

## `src/commands/internship.ts`

```typescript
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

```

---

## `src/commands/test.ts`

```typescript
import {
  ActionRowBuilder,
  MessageFlags,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  type ChatInputCommandInteraction,
  type Client,
} from "discord.js";
import { commandContext, ephemeral, requirePermission } from "../interactions/shared";
import { UserError } from "../lib/errors";
import { infoEmbed, successEmbed, withFooter } from "../lib/embeds";
import { prisma } from "../lib/db";
import {
  addQuestion,
  createTest,
  listActiveTests,
  setTestActive,
  startTest,
  testsListEmbed,
  userTestHistory,
} from "../services/tests";
import { formatDateTime } from "../lib/time";

export const data = new SlashCommandBuilder()
  .setName("test")
  .setDescription("Тестирование: пройти тест, посмотреть результаты, управлять вопросами")
  .addSubcommand((sc) => sc.setName("start").setDescription("Начать тест (вопросы придут в личные сообщения)"))
  .addSubcommand((sc) =>
    sc
      .setName("results")
      .setDescription("Результаты тестов")
      .addUserOption((o) => o.setName("user").setDescription("Сотрудник (для руководства)"))
  )
  .addSubcommand((sc) =>
    sc
      .setName("list")
      .setDescription("Список тестов и вопросов (для руководства)")
  )
  .addSubcommand((sc) =>
    sc
      .setName("create")
      .setDescription("Создать тест")
      .addStringOption((o) => o.setName("name").setDescription("Название теста").setRequired(true).setMaxLength(100))
      .addStringOption((o) => o.setName("description").setDescription("Описание").setMaxLength(500))
      .addIntegerOption((o) =>
        o.setName("pass").setDescription("Проходной балл, % (по умолчанию 70)").setMinValue(1).setMaxValue(100)
      )
      .addIntegerOption((o) =>
        o.setName("attempts").setDescription("Лимит попыток (по умолчанию 3)").setMinValue(1).setMaxValue(20)
      )
      .addRoleOption((o) => o.setName("role").setDescription("Роль за успешную сдачу (по умолчанию — «Пройденный тест»)"))
  )
  .addSubcommand((sc) =>
    sc
      .setName("question")
      .setDescription("Добавить вопрос в тест")
      .addIntegerOption((o) => o.setName("test").setDescription("ID теста (см. /test list)").setRequired(true).setMinValue(1))
      .addStringOption((o) => o.setName("text").setDescription("Текст вопроса").setRequired(true).setMaxLength(900))
      .addStringOption((o) => o.setName("a1").setDescription("Вариант 1").setRequired(true).setMaxLength(300))
      .addStringOption((o) => o.setName("a2").setDescription("Вариант 2").setRequired(true).setMaxLength(300))
      // Обязательные опции в Discord должны идти раньше необязательных,
      // поэтому «correct» расположен перед a3/a4.
      .addIntegerOption((o) =>
        o
          .setName("correct")
          .setDescription("Номер правильного варианта (по числу указанных вариантов)")
          .setRequired(true)
          .addChoices(
            { name: "1", value: 1 },
            { name: "2", value: 2 },
            { name: "3", value: 3 },
            { name: "4", value: 4 }
          )
      )
      .addStringOption((o) => o.setName("a3").setDescription("Вариант 3").setMaxLength(300))
      .addStringOption((o) => o.setName("a4").setDescription("Вариант 4").setMaxLength(300))
  )
  .addSubcommand((sc) =>
    sc
      .setName("toggle")
      .setDescription("Включить/выключить тест")
      .addIntegerOption((o) => o.setName("test").setDescription("ID теста").setRequired(true).setMinValue(1))
      .addBooleanOption((o) => o.setName("active").setDescription("Активен ли тест (по умолчанию — выкл.)"))
  );

export async function execute(interaction: ChatInputCommandInteraction, client: Client): Promise<void> {
  const ctx = await commandContext(interaction);
  const sub = interaction.options.getSubcommand();

  switch (sub) {
    case "start": {
      const tests = await listActiveTests(ctx.guildId);
      if (tests.length === 0) throw new UserError("Активных тестов пока нет. Обратитесь к руководству.");
      if (tests.length === 1) {
        await startTest(client, ctx.guildId, tests[0].id, interaction.user);
        await ephemeral(interaction, {
          embeds: [withFooter(successEmbed("🎓 Тест начат", "Первый вопрос отправлен вам в личные сообщения."))],
        });
        return;
      }
      const select = new StringSelectMenuBuilder()
        .setCustomId("sel:tstpick")
        .setPlaceholder("Выберите тест")
        .addOptions(
          tests.slice(0, 25).map((t) => ({
            label: t.title.slice(0, 100),
            value: String(t.id),
            description: `проходной ${t.passScore}% • попыток ${t.attemptsLimit}`.slice(0, 100),
          }))
        );
      await interaction.reply({
        embeds: [withFooter(infoEmbed("🎓 Выбор теста", "Доступно несколько тестов — выберите нужный."))],
        components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    case "results": {
      const target = interaction.options.getUser("user") ?? interaction.user;
      if (target.id !== interaction.user.id) await requirePermission(ctx, "STATS_VIEW");

      const attempts = await userTestHistory(target.id);
      const embed = infoEmbed(
        `🎓 Результаты тестов — ${target.username}`,
        attempts.length === 0
          ? "Попыток пока не было."
          : attempts
              .map(
                (a) =>
                  `${a.passed ? "✅" : "❌"} **${a.test.title}** — ${a.score ?? "—"}%` +
                  `${a.finishedAt ? ` — ${formatDateTime(a.finishedAt)}` : ""}`
              )
              .join("\n")
      );
      await ephemeral(interaction, { embeds: [withFooter(embed)] });
      return;
    }

    case "list": {
      await requirePermission(ctx, "TEST_MANAGE");
      await ephemeral(interaction, { embeds: [withFooter(await testsListEmbed(ctx.guildId))] });
      return;
    }

    case "create": {
      await requirePermission(ctx, "TEST_MANAGE");
      const role = interaction.options.getRole("role");
      const settings = await prisma.guildSettings.findUnique({ where: { guildId: ctx.guildId } });
      const grantRoleId = role?.id ?? settings?.roleTestPassedId ?? null;

      const test = await createTest(client, ctx.guildId, interaction.user, {
        title: interaction.options.getString("name", true),
        description: interaction.options.getString("description") ?? undefined,
        passScore: interaction.options.getInteger("pass") ?? 70,
        attemptsLimit: interaction.options.getInteger("attempts") ?? 3,
        grantRoleId,
      });

      await ephemeral(interaction, {
        embeds: [
          withFooter(
            successEmbed(
              `🎓 Тест создан: #${test.id}`,
              `**${test.title}**\nПроходной: ${test.passScore}% • Попыток: ${test.attemptsLimit}` +
                `${grantRoleId ? `\nРоль за сдачу: <@&${grantRoleId}>` : ""}\n\nДобавьте вопросы: \`/test question test:${test.id}\``
            )
          ),
        ],
      });
      return;
    }

    case "question": {
      await requirePermission(ctx, "TEST_MANAGE");
      const options = ["a1", "a2", "a3", "a4"]
        .map((key) => interaction.options.getString(key))
        .filter((v): v is string => Boolean(v && v.trim().length > 0));
      const correctIndex = (interaction.options.getInteger("correct", true) ?? 1) - 1;

      const question = await addQuestion(client, ctx.guildId, interaction.user, {
        testId: interaction.options.getInteger("test", true),
        text: interaction.options.getString("text", true),
        options,
        correctIndex,
      });

      await ephemeral(interaction, {
        embeds: [
          withFooter(
            successEmbed(
              "➕ Вопрос добавлен",
              `ID вопроса: **${question.id}**\nВариантов: ${options.length}, правильный: №${correctIndex + 1}.`
            )
          ),
        ],
      });
      return;
    }

    case "toggle": {
      await requirePermission(ctx, "TEST_MANAGE");
      const active = interaction.options.getBoolean("active") ?? false;
      const test = await setTestActive(client, ctx.guildId, interaction.user, interaction.options.getInteger("test", true), active);
      await ephemeral(interaction, {
        embeds: [withFooter(successEmbed("⚙️ Тест обновлён", `#${test.id} «${test.title}» — ${active ? "активен" : "отключён"}.`))],
      });
      return;
    }

    default:
      throw new UserError("Неизвестная подкоманда.");
  }
}

```

---

## `src/commands/rating.ts`

```typescript
import {
  ActionRowBuilder,
  MessageFlags,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type ChatInputCommandInteraction,
  type Client,
} from "discord.js";
import { commandContext, ephemeral, requirePermission } from "../interactions/shared";
import { withFooter } from "../lib/embeds";
import { getTopOrganizers, getUserRating, buildRatingEmbed } from "../services/rating";

export type RatingPeriod = "WEEKLY" | "MONTHLY" | "ALL_TIME";

const PERIOD_RU: Record<RatingPeriod, string> = {
  WEEKLY: "Неделя",
  MONTHLY: "Месяц",
  ALL_TIME: "Всё время",
};

export const data = new SlashCommandBuilder()
  .setName("rating")
  .setDescription("Рейтинг организаторов: очки за проведённые МП")
  .addStringOption((o) =>
    o
      .setName("period")
      .setDescription("Период")
      .setRequired(false)
      .addChoices(
        { name: "Неделя", value: "WEEKLY" },
        { name: "Месяц", value: "MONTHLY" },
        { name: "Всё время", value: "ALL_TIME" }
      )
  )
  .addUserOption((o) =>
    o
      .setName("user")
      .setDescription("Показать рейтинг конкретного организатора")
      .setRequired(false)
  );

export function periodSelectRow(selected: RatingPeriod): ActionRowBuilder<StringSelectMenuBuilder> {
  const menu = new StringSelectMenuBuilder()
    .setCustomId("sel:rating")
    .setPlaceholder(`Период: ${PERIOD_RU[selected]}`)
    .addOptions(
      (Object.keys(PERIOD_RU) as RatingPeriod[]).map((p) =>
        new StringSelectMenuOptionBuilder().setLabel(PERIOD_RU[p]).setValue(p)
      )
    );
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

export async function execute(interaction: ChatInputCommandInteraction, client: Client): Promise<void> {
  const ctx = await commandContext(interaction);
  await requirePermission(ctx, "STATS_VIEW");

  const period = (interaction.options.getString("period") as RatingPeriod | null) ?? "ALL_TIME";
  const targetUser = interaction.options.getUser("user");

  if (targetUser) {
    // Показываем рейтинг конкретного пользователя
    const rating = await getUserRating(ctx.guildId, targetUser.id, period);
    if (!rating) {
      await interaction.reply({
        content: `У пользователя ${targetUser} пока нет очков рейтинга.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const embed = buildRatingEmbed([rating], period, interaction.guild?.name ?? "Отдел");
    await interaction.reply({
      embeds: [withFooter(embed)],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Показываем топ организаторов
  const top = await getTopOrganizers(ctx.guildId, period, 10);
  const embed = buildRatingEmbed(top, period, interaction.guild?.name ?? "Отдел");

  await interaction.reply({
    embeds: [withFooter(embed)],
    components: [periodSelectRow(period)],
    flags: MessageFlags.Ephemeral,
  });
}

```

---

## `src/commands/template.ts`

```typescript
import {
  ActionRowBuilder,
  MessageFlags,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type ChatInputCommandInteraction,
  type Client,
} from "discord.js";
import { commandContext, ephemeral, requirePermission } from "../interactions/shared";
import { withFooter } from "../lib/embeds";
import {
  createTemplate,
  getTemplates,
  getTemplate,
  deleteTemplate,
  buildTemplatesEmbed,
  buildTemplateEmbed,
  type TemplateInput,
} from "../services/templates";
import { prisma } from "../lib/db";

export const data = new SlashCommandBuilder()
  .setName("template")
  .setDescription("Шаблоны мероприятий: быстрое создание МП из сохранённого сценария")
  .addSubcommand((sub) =>
    sub
      .setName("create")
      .setDescription("Создать новый шаблон МП")
      .addStringOption((o) =>
        o.setName("name").setDescription("Название шаблона").setRequired(true)
      )
      .addIntegerOption((o) =>
        o.setName("category_id").setDescription("ID категории МП").setRequired(true)
      )
      .addStringOption((o) =>
        o.setName("description").setDescription("Описание мероприятия").setRequired(true)
      )
      .addStringOption((o) =>
        o.setName("rules").setDescription("Правила мероприятия").setRequired(false)
      )
      .addIntegerOption((o) =>
        o.setName("duration").setDescription("Продолжительность (мин)").setRequired(false)
      )
      .addIntegerOption((o) =>
        o.setName("participants").setDescription("Количество участников").setRequired(false)
      )
      .addStringOption((o) =>
        o.setName("location").setDescription("Место проведения").setRequired(false)
      )
  )
  .addSubcommand((sub) =>
    sub.setName("list").setDescription("Список всех шаблонов МП")
  )
  .addSubcommand((sub) =>
    sub
      .setName("use")
      .setDescription("Использовать шаблон для создания МП")
      .addIntegerOption((o) =>
        o.setName("template_id").setDescription("ID шаблона").setRequired(true)
      )
      .addStringOption((o) =>
        o.setName("date").setDescription("Дата (ДД.ММ.ГГГГ)").setRequired(true)
      )
      .addStringOption((o) =>
        o.setName("time").setDescription("Время (ЧЧ:ММ)").setRequired(true)
      )
      .addStringOption((o) =>
        o.setName("title").setDescription("Название МП (переопределяет название шаблона)").setRequired(false)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("delete")
      .setDescription("Удалить шаблон")
      .addIntegerOption((o) =>
        o.setName("template_id").setDescription("ID шаблона").setRequired(true)
      )
  );

export async function execute(interaction: ChatInputCommandInteraction, client: Client): Promise<void> {
  const ctx = await commandContext(interaction);
  const subcommand = interaction.options.getSubcommand();

  switch (subcommand) {
    case "create": {
      await requirePermission(ctx, "CREATE_APPLICATION");

      const input: TemplateInput = {
        name: interaction.options.getString("name", true),
        categoryId: interaction.options.getInteger("category_id", true),
        description: interaction.options.getString("description", true),
        rules: interaction.options.getString("rules") ?? undefined,
        durationMinutes: interaction.options.getInteger("duration") ?? 60,
        participantsPlanned: interaction.options.getInteger("participants") ?? 20,
        location: interaction.options.getString("location") ?? undefined,
      };

      const template = await createTemplate(client, ctx.guildId, interaction.user, input);

      await interaction.reply({
        embeds: [withFooter(buildTemplateEmbed(template))],
        flags: MessageFlags.Ephemeral,
      });
      break;
    }

    case "list": {
      await requirePermission(ctx, "STATS_VIEW");

      const templates = await getTemplates(ctx.guildId);
      const embed = buildTemplatesEmbed(templates, interaction.guild?.name ?? "Отдел");

      await interaction.reply({
        embeds: [withFooter(embed)],
        flags: MessageFlags.Ephemeral,
      });
      break;
    }

    case "use": {
      await requirePermission(ctx, "CREATE_APPLICATION");

      const templateId = interaction.options.getInteger("template_id", true);
      const title = interaction.options.getString("title") ?? undefined;
      const dateStr = interaction.options.getString("date", true);
      const timeStr = interaction.options.getString("time", true);

      // Получаем шаблон
      const template = await getTemplate(templateId);

      // Создаём селект для подтверждения
      const embed = buildTemplateEmbed(template);
      embed.setDescription(
        embed.data.description + "\n\n**Использовать этот шаблон для создания МП?**\n" +
        `Дата: ${dateStr} ${timeStr}`
      );

      const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`sel:template-use:${templateId}:${dateStr}:${timeStr}:${title ?? ""}`)
          .setPlaceholder("Выберите действие")
          .addOptions(
            new StringSelectMenuOptionBuilder()
              .setLabel("Использовать шаблон")
              .setValue("use")
              .setEmoji("✅"),
            new StringSelectMenuOptionBuilder()
              .setLabel("Отмена")
              .setValue("cancel")
              .setEmoji("❌")
          )
      );

      await interaction.reply({
        embeds: [withFooter(embed)],
        components: [row],
        flags: MessageFlags.Ephemeral,
      });
      break;
    }

    case "delete": {
      await requirePermission(ctx, "EDIT_ANY_EVENT");

      const templateId = interaction.options.getInteger("template_id", true);
      await deleteTemplate(client, ctx.guildId, templateId, interaction.user);

      await interaction.reply({
        content: `Шаблон #${templateId} успешно удалён.`,
        flags: MessageFlags.Ephemeral,
      });
      break;
    }
  }
}

```

---

## `src/commands/rotation.ts`

```typescript
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

```

---

## `src/commands/material.ts`

```typescript
import {
  ActionRowBuilder,
  ModalBuilder,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Client,
} from "discord.js";
import { commandContext, ephemeral, requirePermission } from "../interactions/shared";
import { infoEmbed, successEmbed, withFooter } from "../lib/embeds";
import { UserError } from "../lib/errors";
import {
  archiveMaterial,
  attachMaterial,
  detachMaterial,
  formatMaterialBody,
  formatMaterialList,
  getMaterial,
  listEventMaterials,
  searchMaterials,
} from "../services/materials";
import { setDraft } from "../interactions/drafts";
import { prisma } from "../lib/db";
import { autocompleteEvents, eventFromOption } from "./common";

export const data = new SlashCommandBuilder()
  .setName("material")
  .setDescription("База материалов для игр: вопросы, темы, сценарии")
  .addSubcommand((s) =>
    s
      .setName("add")
      .setDescription("Добавить материал (название + содержимое в форме)")
      .addStringOption((o) => o.setName("title").setDescription("Название").setRequired(true).setMaxLength(100))
      .addStringOption((o) => o.setName("category").setDescription("Категория МП (например: Мафия)").setAutocomplete(true))
      .addStringOption((o) => o.setName("tags").setDescription("Теги через запятую").setMaxLength(200))
  )
  .addSubcommand((s) =>
    s
      .setName("list")
      .setDescription("Список материалов с поиском")
      .addStringOption((o) => o.setName("query").setDescription("Что искать (название, теги, содержимое)"))
  )
  .addSubcommand((s) =>
    s
      .setName("show")
      .setDescription("Показать материал целиком")
      .addStringOption((o) => o.setName("material").setDescription("Материал").setRequired(true).setAutocomplete(true))
  )
  .addSubcommand((s) =>
    s
      .setName("attach")
      .setDescription("Прикрепить материал к мероприятию")
      .addStringOption((o) => o.setName("event").setDescription("Мероприятие").setRequired(true).setAutocomplete(true))
      .addStringOption((o) => o.setName("material").setDescription("Материал").setRequired(true).setAutocomplete(true))
  )
  .addSubcommand((s) =>
    s
      .setName("detach")
      .setDescription("Открепить материал от мероприятия")
      .addStringOption((o) => o.setName("event").setDescription("Мероприятие").setRequired(true).setAutocomplete(true))
      .addStringOption((o) => o.setName("material").setDescription("Материал").setRequired(true).setAutocomplete(true))
  )
  .addSubcommand((s) =>
    s
      .setName("attached")
      .setDescription("Материалы, прикреплённые к мероприятию")
      .addStringOption((o) => o.setName("event").setDescription("Мероприятие").setRequired(true).setAutocomplete(true))
  )
  .addSubcommand((s) =>
    s
      .setName("delete")
      .setDescription("Убрать материал в архив (Старший Организатор и выше)")
      .addStringOption((o) => o.setName("material").setDescription("Материал").setRequired(true).setAutocomplete(true))
  );

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused(true);
  if (focused.name === "event") return autocompleteEvents(interaction);

  if (!interaction.guildId) return interaction.respond([]);

  if (focused.name === "category") {
    const categories = await prisma.eventCategory.findMany({
      where: { guildId: interaction.guildId, active: true, name: { contains: String(focused.value) } },
      orderBy: { name: "asc" },
      take: 25,
    });
    return interaction.respond(categories.map((c) => ({ name: c.name, value: c.name })));
  }

  if (focused.name === "material") {
    const materials = await searchMaterials(interaction.guildId, String(focused.value));
    return interaction.respond(
      materials.slice(0, 25).map((m) => ({
        name: `#${m.id} ${m.title}`.slice(0, 100),
        value: String(m.id),
      }))
    );
  }
  return interaction.respond([]);
}

export async function execute(interaction: ChatInputCommandInteraction, _client: Client): Promise<void> {
  const ctx = await commandContext(interaction);
  const sub = interaction.options.getSubcommand(true);

  switch (sub) {
    case "add": {
      await requirePermission(ctx, "CREATE_APPLICATION");
      const title = interaction.options.getString("title", true).trim();
      const tags = interaction.options.getString("tags") ?? "";
      const categoryName = interaction.options.getString("category");

      let categoryId: number | null = null;
      if (categoryName) {
        const category = await prisma.eventCategory.findFirst({
          where: { guildId: ctx.guildId, active: true, name: { equals: categoryName.trim() } },
        });
        if (!category) {
          throw new UserError(`Категория «${categoryName}» не найдена. Выберите название из автодополнения.`);
        }
        categoryId = category.id;
      }

      // Содержимое заполняется модальной формой (длинный текст неудобен в опции).
      setDraft(`mat:${interaction.user.id}`, { title, tags, categoryId });
      const modal = new ModalBuilder()
        .setCustomId("mdl:mat")
        .setTitle("Новый материал".slice(0, 45))
        .addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId("body")
              .setLabel("Содержимое (вопросы, темы, сценарий)")
              .setStyle(TextInputStyle.Paragraph)
              .setMinLength(5)
              .setMaxLength(3900)
              .setRequired(true)
          )
        );
      await interaction.showModal(modal);
      break;
    }
    case "list": {
      await requirePermission(ctx, "CREATE_APPLICATION");
      const query = interaction.options.getString("query") ?? "";
      const materials = await searchMaterials(ctx.guildId, query);
      await ephemeral(interaction, {
        embeds: [
          withFooter(
            infoEmbed(
              `📚 Материалы${query ? ` — «${query}»` : ""}`,
              formatMaterialList(materials).slice(0, 3800)
            )
          ),
        ],
      });
      break;
    }
    case "show": {
      await requirePermission(ctx, "CREATE_APPLICATION");
      const material = await getMaterial(ctx.guildId, interaction.options.getString("material", true));
      await ephemeral(interaction, {
        embeds: [withFooter(infoEmbed(`📚 #${material.id} ${material.title}`, formatMaterialBody(material)))],
      });
      break;
    }
    case "attach": {
      await requirePermission(ctx, "CREATE_APPLICATION");
      const event = await eventFromOption(interaction);
      const material = await getMaterial(ctx.guildId, interaction.options.getString("material", true));
      await attachMaterial(event.id, material.id, interaction.user.id);
      await ephemeral(interaction, {
        embeds: [successEmbed("📚 Материал прикреплён", `#${material.id} «${material.title}» → ${event.code}. Виден в карточке МП по кнопке «Материалы».`)],
      });
      break;
    }
    case "detach": {
      await requirePermission(ctx, "CREATE_APPLICATION");
      const event = await eventFromOption(interaction);
      const material = await getMaterial(ctx.guildId, interaction.options.getString("material", true));
      await detachMaterial(event.id, material.id);
      await ephemeral(interaction, {
        embeds: [successEmbed("📚 Материал откреплён", `#${material.id} «${material.title}» больше не прикреплён к ${event.code}.`)],
      });
      break;
    }
    case "attached": {
      await requirePermission(ctx, "CREATE_APPLICATION");
      const event = await eventFromOption(interaction);
      const materials = await listEventMaterials(event.id);
      await ephemeral(interaction, {
        embeds: [
          withFooter(
            infoEmbed(`📚 Материалы ${event.code}`, materials.length === 0 ? "Не прикреплены." : formatMaterialList(materials).slice(0, 3800))
          ),
        ],
      });
      break;
    }
    case "delete": {
      await requirePermission(ctx, "EDIT_ANY_EVENT");
      const material = await archiveMaterial(ctx.guildId, interaction.options.getString("material", true));
      await ephemeral(interaction, {
        embeds: [successEmbed("📚 Материал в архиве", `#${material.id} «${material.title}» скрыт из списка (привязки к МП сохранены).`)],
      });
      break;
    }
    default:
      throw new UserError("Неизвестная подкоманда.");
  }
}

```

---

## `src/commands/common.ts`

```typescript
import {
  PermissionFlagsBits,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
} from "discord.js";
import { findEvent, type EventWithCategory } from "../services/events";
import { UserError } from "../lib/errors";
import type { InteractionContext } from "../interactions/shared";
import { hasAtLeast, type Position } from "../permissions/matrix";
import { prisma } from "../lib/db";

/// Видимость slash-команд в Discord (UX, не защита):
/// реальная проверка прав всегда выполняется в бэкенде через requirePermission.
export const VIS_ADMIN = PermissionFlagsBits.Administrator;      // /setup
export const VIS_LEADERSHIP = PermissionFlagsBits.ManageGuild;   // кадры, архив, логи
export const VIS_STAFF = PermissionFlagsBits.ManageMessages;     // проверка заявок, управление МП

/// Позиции, управляющие мероприятием: автор, организатор или проверяющие.
export function canManageEvent(ctx: InteractionContext, event: EventWithCategory): boolean {
  const reviewer = hasAtLeast(ctx.position, "SENIOR");
  const mine = ctx.userId === event.authorId || ctx.userId === event.organizerId;
  return reviewer || mine;
}

export function assertCanManageEvent(ctx: InteractionContext, event: EventWithCategory): void {
  if (!canManageEvent(ctx, event)) {
    throw new UserError("Управлять мероприятием может его автор, организатор или руководство (Старший Организатор и выше).");
  }
}

/// Читает опцию «event» (код MP-XXXX или числовой ID) и возвращает мероприятие.
export async function eventFromOption(
  interaction: ChatInputCommandInteraction,
  optionName = "event"
): Promise<EventWithCategory> {
  const raw = interaction.options.getString(optionName, true);
  if (!interaction.guildId) throw new UserError("Команда доступна только на сервере.");
  return findEvent(interaction.guildId, raw);
}

/// Автодополнение кодов мероприятий (MP-XXXX) и названий.
export async function autocompleteEvents(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused().toLowerCase();
  if (!interaction.guildId) return interaction.respond([]);

  const events = await prisma.event.findMany({
    where: {
      guildId: interaction.guildId,
      ...(focused ? { OR: [{ code: { contains: focused } }, { title: { contains: focused } }] } : {}),
    },
    orderBy: { id: "desc" },
    take: 25,
    select: { code: true, title: true, status: true },
  });

  await interaction.respond(
    events.map((e) => ({
      name: `${e.code} — ${e.title}`.slice(0, 100),
      value: e.code,
    }))
  );
}

/// Автодополнение сотрудников отдела (из БД — источник истины по должностям).
export async function autocompleteStaff(interaction: AutocompleteInteraction, minRank: Position = "ASSISTANT"): Promise<void> {
  const focused = interaction.options.getFocused().toLowerCase();
  const users = await prisma.user.findMany({
    where: {
      leftAt: null,
      position: { not: "GUEST" },
      ...(focused
        ? { OR: [{ nickname: { contains: focused } }, { username: { contains: focused } }, { discordId: focused }] }
        : {}),
    },
    orderBy: { position: "desc" },
    take: 25,
  });

  const allowed = users.filter((u) => {
    const pos = u.position as Position;
    return ["ADMIN", "CURATOR", "HEAD", "SENIOR", "ORGANIZER", "ASSISTANT"].includes(pos) && hasAtLeast(pos, minRank);
  });

  await interaction.respond(
    allowed.map((u) => ({
      name: `${u.nickname ?? u.username} (${u.position})`.slice(0, 100),
      value: u.discordId,
    }))
  );
}

```

---

## `src/commands/index.ts`

```typescript
import type { AutocompleteInteraction, ChatInputCommandInteraction, Client } from "discord.js";
import * as setup from "./setup";
import * as createEvent from "./createEvent";
import * as events from "./events";
import * as myEvents from "./myEvents";
import * as event from "./event";
import * as editEvent from "./editEvent";
import * as cancelEvent from "./cancelEvent";
import * as approve from "./approve";
import * as reject from "./reject";
import * as requestRevision from "./requestRevision";
import * as assign from "./assign";
import * as startEvent from "./startEvent";
import * as finishEvent from "./finishEvent";
import * as report from "./report";
import * as archive from "./archive";
import * as stats from "./stats";
import * as rating from "./rating";
import * as template from "./template";
import * as calendar from "./calendar";
import * as exportCmd from "./export";
import * as profile from "./profile";
import * as test from "./test";
import * as promote from "./promote";
import * as warning from "./warning";
import * as reprimand from "./reprimand";
import * as discipline from "./discipline";
import * as internship from "./internship";
import * as logs from "./logs";
import * as rotation from "./rotation";
import * as material from "./material";

export interface SlashCommandModule {
  data: {
    name: string;
    description: string;
    toJSON: () => unknown;
  };
  execute: (interaction: ChatInputCommandInteraction, client: Client) => Promise<void>;
  autocomplete?: (interaction: AutocompleteInteraction) => Promise<void>;
}

/// Реестр slash-команд. Регистрация выполняется в index.ts с проверкой
/// расхождений — при каждом запуске команды не перерегистрируются без нужды.
export const commands: SlashCommandModule[] = [
  setup,
  createEvent,
  events,
  myEvents,
  event,
  editEvent,
  cancelEvent,
  approve,
  reject,
  requestRevision,
  assign,
  startEvent,
  finishEvent,
  report,
  archive,
  stats,
  rating,
  template,
  calendar,
  exportCmd,
  profile,
  test,
  promote,
  warning,
  reprimand,
  discipline,
  internship,
  logs,
  rotation,
  material,
];

export function getCommand(name: string): SlashCommandModule | undefined {
  return commands.find((c) => c.data.name === name);
}

```

