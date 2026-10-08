import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type EmbedBuilder,
  type InteractionReplyOptions,
} from "discord.js";
import { UserError } from "../lib/errors";
import { errorEmbed, infoEmbed, successEmbed, warnEmbed, withFooter } from "../lib/embeds";
import { ephemeral, requireContext, requirePermission, safeExecute, type InteractionContext } from "./shared";
import {
  loadEvent,
  approveEvent,
  startEvent,
  finishEvent,
  resubmitEvent,
  archiveEvent,
  updatePlanningBoard,
  updateActiveBoard,
  updateStatsBoard,
} from "../services/events";
import { toggleSignup } from "../services/announcements";
import { formatChecklist, getChecklist, markChecklist, toggleChecklistItem } from "../services/checklist";
import { formatAttendance, getAttendance } from "../services/attendance";
import { assertRateable, formatDistribution, getFeedbackStats, submitFeedback } from "../services/feedback";
import { listEventMaterials } from "../services/materials";
import { prisma } from "../lib/db";
import { STATUS, STATUS_RU } from "../constants";
import { formatDateTime, formatDuration } from "../lib/time";
import { writeAudit } from "../services/audit";
import { handleAnswer, listActiveTests } from "../services/tests";

export async function handleButton(interaction: ButtonInteraction): Promise<void> {
  const parts = interaction.customId.split(":");
  const [namespace, action, ...rest] = parts;
  if (!["mp", "ev", "app", "tst", "board", "fb"].includes(namespace)) return;

  // Ответы на вопросы теста приходят из ЛС — работают без контекста гильдии.
  if (namespace === "tst" && action === "a") {
    const [, , attemptId, qIdx, optIdx] = parts;
    await safeExecute(interaction, async () => {
      await handleAnswer(interaction.client, Number(attemptId), Number(qIdx), Number(optIdx), interaction.user);
      await ephemeral(interaction, { embeds: [successEmbed("✅ Ответ принят", "Следующий вопрос отправлен в личные сообщения.")] });
    });
    return;
  }

  // Запись «Буду» и оценка МП — работают из анонса в любом гильдии
  // (в т.ч. на официальном сервере, где нет настроек отдела).
  if (namespace === "mp" && action === "join") {
    await safeExecute(interaction, async () => {
      const event = await loadEvent(Number(rest[0]));
      if (![STATUS.APPROVED, STATUS.PLANNED, STATUS.ACTIVE].includes(event.status as never)) {
        throw new UserError("Запись закрыта: мероприятие уже не запланировано.");
      }
      const result = await toggleSignup(interaction.client, event, interaction.user.id);
      await ephemeral(interaction, {
        embeds: [
          result.joined
            ? successEmbed("✅ Вы записаны!", `Всего записалось: **${result.count}**.\nНачало: ${formatDateTime(event.scheduledAt)}`)
            : infoEmbed("❎ Запись отменена", `Осталось записанных: **${result.count}**.`),
        ],
      });
    });
    return;
  }

  if (namespace === "fb" && action === "score") {
    await safeExecute(interaction, async () => {
      const event = await loadEvent(Number(rest[0]));
      assertRateable(event.status);
      const score = Number(rest[1]);
      await submitFeedback(event.id, interaction.user.id, score);
      const stats = await getFeedbackStats(event.id, interaction.user.id);
      await ephemeral(interaction, {
        embeds: [
          successEmbed(
            `⭐ Оценка ${score}/5 принята`,
            `Средняя оценка МП: **${stats.average}** (${stats.count} оценок). Спасибо за отзыв!`
          ),
        ],
      });
    });
    return;
  }

  await safeExecute(interaction, async () => {
    const ctx = await requireContext(interaction);

    switch (`${namespace}:${action}`) {
      case "app:create": {
        await requirePermission(ctx, "CREATE_APPLICATION");
        await showCategorySelect(interaction);
        break;
      }
      case "app:step2": {
        await requirePermission(await requireContext(interaction), "CREATE_APPLICATION");
        await interaction.showModal(applicationModalStep2());
        break;
      }
      case "ev:report2": {
        await requireContext(interaction);
        await interaction.showModal(reportModalStep2());
        break;
      }
      case "tst:start": {
        const tests = await listActiveTests(ctx.guildId);
        if (tests.length === 0) throw new UserError("Активных тестов пока нет. Обратитесь к руководству.");
        if (tests.length === 1) {
          const { startTest } = await import("../services/tests");
          await startTest(interaction.client, ctx.guildId, tests[0].id, interaction.user);
          await ephemeral(interaction, { embeds: [successEmbed("🎓 Тест начат", "Первый вопрос отправлен вам в личные сообщения.")] });
        } else {
          const select = new StringSelectMenuBuilder()
            .setCustomId("sel:tstpick")
            .setPlaceholder("Выберите тест")
            .addOptions(tests.slice(0, 25).map((t) => new StringSelectMenuOptionBuilder().setLabel(t.title).setValue(String(t.id))));
          await interaction.reply({
            embeds: [withFooter(infoEmbed("🎓 Выбор теста", "Доступно несколько тестов — выберите нужный."))],
            components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
            flags: MessageFlags.Ephemeral,
          });
        }
        break;
      }
      case "mp:edit": {
        const event = await loadEvent(Number(rest[0]));
        if (event.authorId !== interaction.user.id && !["ADMIN", "CURATOR", "HEAD", "SENIOR"].includes(ctx.position)) {
          throw new UserError("Редактировать заявку может только её автор или руководство.");
        }
        if (["ACTIVE", "COMPLETED", "REPORTED", "ARCHIVED", "REJECTED", "CANCELLED"].includes(event.status)) {
          throw new UserError("Заявка в текущем статусе не редактируется.");
        }
        await interaction.showModal(editModal(event.id, event));
        break;
      }
      case "mp:approve": {
        await requirePermission(ctx, "REVIEW");
        const event = await loadEvent(Number(rest[0]));
        if (event.status !== "PENDING" && event.status !== "REVISION") {
          throw new UserError(`Заявка уже обработана (статус: ${STATUS_RU[event.status].label}).`);
        }
        await approveEvent(interaction.client, event, interaction.user);
        await ephemeral(interaction, {
          embeds: [successEmbed("✅ Одобрено", `Заявка ${event.code} переведена в планирование. Канал МП и голосовая созданы.`)],
        });
        break;
      }
      case "mp:revision": {
        await requirePermission(ctx, "REVIEW");
        const event = await loadEvent(Number(rest[0]));
        await interaction.showModal(reasonModal("revision", event.id, `Доработка ${event.code}`));
        break;
      }
      case "mp:reject": {
        await requirePermission(ctx, "REVIEW");
        const event = await loadEvent(Number(rest[0]));
        await interaction.showModal(reasonModal("reject", event.id, `Отклонение ${event.code}`));
        break;
      }
      case "mp:assign": {
        await requirePermission(ctx, "ASSIGN");
        const event = await loadEvent(Number(rest[0]));
        await showAssignSelect(interaction, event.id, event.code);
        break;
      }
      case "mp:resubmit": {
        const event = await loadEvent(Number(rest[0]));
        if (event.authorId !== interaction.user.id) throw new UserError("Повторно отправить заявку может только её автор.");
        if (event.status !== "REVISION") throw new UserError("Заявка не находится на доработке.");
        await resubmitEvent(interaction.client, event, interaction.user);
        await ephemeral(interaction, { embeds: [successEmbed("📨 Заявка отправлена повторно", `${event.code} снова на проверке.`)] });
        break;
      }
      case "ev:start": {
        const event = await loadEvent(Number(rest[0]));
        assertEventManage(ctx, event);
        if (event.status !== "APPROVED" && event.status !== "PLANNED") {
          throw new UserError(`Запустить можно только запланированное МП (сейчас: ${STATUS_RU[event.status].label}).`);
        }
        await startEvent(interaction.client, event, interaction.user);
        await ephemeral(interaction, { embeds: [successEmbed("▶️ МП запущено", `${event.code} «${event.title}» переведено в статус «Проводится».`)] });
        break;
      }
      case "ev:finish": {
        const event = await loadEvent(Number(rest[0]));
        assertEventManage(ctx, event);
        if (event.status !== "ACTIVE") throw new UserError("Завершить можно только идущее МП.");
        await finishEvent(interaction.client, event, interaction.user);
        await ephemeral(interaction, { embeds: [successEmbed("🏁 МП завершено", "Не забудьте создать отчёт кнопкой «Создать отчёт».")] });
        break;
      }
      case "ev:report": {
        const event = await loadEvent(Number(rest[0]));
        if (event.status !== "COMPLETED") throw new UserError("Отчёт создаётся после завершения МП.");
        if (event.report) throw new UserError("Отчёт уже сдан.");
        assertEventManage(ctx, event);
        await interaction.showModal(reportModal(event.id));
        break;
      }
      case "ev:team": {
        const event = await loadEvent(Number(rest[0]));
        const staff = await prisma.eventStaff.findMany({ where: { eventId: event.id }, include: { user: true } });
        await ephemeral(interaction, {
          embeds: [
            withFooter(
              infoEmbed(
                `👥 Команда ${event.code}`,
                staff.length === 0
                  ? "Команда не назначена."
                  : staff.map((s) => `<@${s.userId}> — ${s.role === "ORGANIZER" ? "🎯 организатор" : "🤝 помощник"}`).join("\n")
              )
            ),
          ],
        });
        break;
      }
      case "ev:announce": {
        const event = await loadEvent(Number(rest[0]));
        assertEventManage(ctx, event);
        if (!ctx.settings.announcementsChannelId) throw new UserError("Канал объявлений не настроен.");
        const channel = await interaction.client.channels.fetch(ctx.settings.announcementsChannelId).catch(() => null);
        if (channel?.type !== ChannelType.GuildText) throw new UserError("Канал объявлений недоступен.");
        await channel.send({
          embeds: [
            withFooter(
              infoEmbed(
                `📢 ${event.category.emoji} ${event.title}`,
                [
                  `**Когда:** ${formatDateTime(event.scheduledAt)}`,
                  `**Сколько:** ${formatDuration(event.durationMinutes)}`,
                  `**Где:** ${event.location ?? "уточняется"}`,
                  `**Для кого:** ${event.participantsPlanned}+ участников`,
                  "",
                  event.description.slice(0, 1500),
                ].join("\n")
              )
            ),
          ],
        });
        await writeAudit(interaction.client, {
          guildId: ctx.guildId,
          action: "EVENT_UPDATED",
          actorId: interaction.user.id,
          actorTag: interaction.user.tag,
          targetType: "event",
          targetId: event.code,
          newValue: "Опубликовано объявление",
        });
        await markChecklist(event.id, "ANNOUNCE", true);
        await ephemeral(interaction, { embeds: [successEmbed("📢 Объявление опубликовано", `Размещено в <#${ctx.settings.announcementsChannelId}>.`)] });
        break;
      }
      case "ev:checklist": {
        const event = await loadEvent(Number(rest[0]));
        assertEventManage(ctx, event);
        await ephemeral(interaction, await checklistPayload(event.id, event.code));
        break;
      }
      case "ev:chk": {
        const event = await loadEvent(Number(rest[0]));
        assertEventManage(ctx, event);
        await toggleChecklistItem(event.id, rest[1], interaction.user.id);
        // Обновляем сообщение чек-листа на месте (кнопка лежит именно в нём).
        await interaction.update(await checklistPayload(event.id, event.code));
        break;
      }
      case "ev:people": {
        const event = await loadEvent(Number(rest[0]));
        assertEventManage(ctx, event);
        const signups = await prisma.eventSignup.findMany({ where: { eventId: event.id }, orderBy: { createdAt: "asc" } });
        const attendance = await getAttendance(event.id);
        const signupLines = signups.length === 0
          ? "Записей «Буду» пока нет."
          : signups.map((s, i) => `${i + 1}. <@${s.userId}> — ${formatDateTime(s.createdAt)}`).join("\n");
        const attendanceText = formatAttendance(attendance) ?? "\nДанных по голосовому каналу нет (МП ещё не проводилось или голосовая не использовалась).";
        await ephemeral(interaction, {
          embeds: [
            withFooter(
              infoEmbed(
                `👥 Участники ${event.code}`,
                `**Записались («Буду»): ${signups.length}**\n${signupLines.slice(0, 1800)}\n\n${attendanceText}`.slice(0, 3800)
              )
            ),
          ],
        });
        break;
      }
      case "ev:materials": {
        const event = await loadEvent(Number(rest[0]));
        const materials = await listEventMaterials(event.id);
        const body = materials.length === 0
          ? "Материалы не прикреплены. Прикрепите через `/material attach`."
          : materials
              .map((m, i) => `${i + 1}. **#${m.id} ${m.title}**${m.tags ? ` — _${m.tags}_` : ""}\n${m.body.slice(0, 400)}…`)
              .join("\n\n");
        await ephemeral(interaction, {
          embeds: [withFooter(infoEmbed(`📚 Материалы ${event.code}`, body.slice(0, 3800)))],
        });
        break;
      }
      case "ev:feedback": {
        const event = await loadEvent(Number(rest[0]));
        const stats = await getFeedbackStats(event.id, interaction.user.id);
        await ephemeral(interaction, {
          embeds: [
            withFooter(
              infoEmbed(
                `⭐ Оценки ${event.code}`,
                stats.count === 0
                  ? "Оценок пока нет. Опубликуйте анонс завершения — кнопки оценки появятся в нём."
                  : `**Средняя оценка: ${stats.average}** из 5 (${stats.count} оценок)\n\n${formatDistribution(stats)}` +
                      (stats.myScore ? `\n\nВаша оценка: ${stats.myScore}/5` : "")
              )
            ),
          ],
        });
        break;
      }
      case "ev:scenario": {
        const event = await loadEvent(Number(rest[0]));
        await ephemeral(interaction, {
          embeds: [
            withFooter(
              infoEmbed(
                `📋 Сценарий — ${event.title}`,
                [
                  event.description,
                  event.rules ? `\n**Правила:**\n${event.rules}` : "",
                  event.extraInfo ? `\n**Дополнительно:**\n${event.extraInfo}` : "",
                ]
                  .join("\n")
                  .trim() || "Сценарий не заполнен."
              )
            ),
          ],
        });
        break;
      }
      case "ev:archive": {
        await requirePermission(ctx, "ARCHIVE");
        const event = await loadEvent(Number(rest[0]));
        if (event.status !== "REPORTED") {
          throw new UserError(`Архивирование доступно только после сдачи отчёта (сейчас: ${STATUS_RU[event.status].label}).`);
        }
        const archived = await archiveEvent(interaction.client, event, interaction.user);
        await ephemeral(interaction, {
          embeds: [successEmbed("🗃️ МП заархивировано", `${archived.code} закрыт. Полная история сохранена в БД.`)],
        });
        break;
      }
      case "ev:history": {
        const event = await loadEvent(Number(rest[0]));
        const history = await prisma.eventStatusHistory.findMany({
          where: { eventId: event.id },
          orderBy: { createdAt: "asc" },
          take: 15,
        });
        const lines: string[] = history.length === 0
          ? ["История пуста."]
          : history.map((h) => {
              const from = h.fromStatus ? (STATUS_RU[h.fromStatus]?.label ?? h.fromStatus) : "создано";
              const to = STATUS_RU[h.toStatus]?.label ?? h.toStatus;
              return `**${formatDateTime(h.createdAt)}** — ${from} → **${to}**${h.actorId ? ` — <@${h.actorId}>` : ""}${h.reason ? `\n_Причина:_ ${h.reason}` : ""}`;
            });
        await ephemeral(interaction, {
          embeds: [withFooter(infoEmbed(`🕒 История ${event.code}`, lines.join("\n").slice(0, 3900)))],
        });
        break;
      }
      case "board:refresh": {
        await requirePermission(ctx, "STATS_VIEW");
        const key = rest[0];
        if (key === "PLANNING") await updatePlanningBoard(interaction.client, ctx.guildId);
        else if (key === "ACTIVE") await updateActiveBoard(interaction.client, ctx.guildId);
        else if (key === "STATS") await updateStatsBoard(interaction.client, ctx.guildId, interaction.guild?.name ?? "Отдел");
        else throw new UserError("Неизвестная панель.");
        await ephemeral(interaction, { embeds: [successEmbed("🔄 Обновлено", "Панель перестроена из базы данных.")] });
        break;
      }
      default:
        await ephemeral(interaction, { embeds: [errorEmbed("❌ Неизвестное действие", "Эта кнопка устарела или не поддерживается.")] });
    }
  });
}

/// Автор/организатор мероприятия или проверяющий состав.
function assertEventManage(ctx: InteractionContext, event: { authorId: string; organizerId: string | null }): void {
  const isReviewer = ["ADMIN", "CURATOR", "HEAD", "SENIOR"].includes(ctx.position);
  const isMine = ctx.userId === event.authorId || ctx.userId === event.organizerId;
  if (!isReviewer && !isMine) {
    throw new UserError("Управлять мероприятием может его автор, организатор или руководство.");
  }
}

/// Эмбед + кнопки чек-листа: ручные пункты переключаются прямо в сообщении.
async function checklistPayload(
  eventId: number,
  code: string
): Promise<{ embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] }> {
  const items = await getChecklist(eventId);
  const done = items.filter((i) => i.done).length;
  const manual = items.filter((i) => !i.auto);
  const components =
    manual.length > 0
      ? [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            ...manual.map((i) =>
              new ButtonBuilder()
                .setCustomId(`ev:chk:${eventId}:${i.key}`)
                .setLabel(`${i.done ? "✅" : "⬜"} ${i.label}`.slice(0, 80))
                .setStyle(i.done ? ButtonStyle.Success : ButtonStyle.Secondary)
            )
          ),
        ]
      : [];
  const embed =
    done === items.length
      ? successEmbed(`✅ Чек-лист ${code} — закрыт`, formatChecklist(items))
      : warnEmbed(
          `📝 Чек-лист ${code} — ${done}/${items.length}`,
          `${formatChecklist(items)}\n\n_Незакрытые пункты блокируют запуск МП._`
        );
  return { embeds: [withFooter(embed)], components };
}

export function editModal(eventId: number, event: import("@prisma/client").Event): ModalBuilder {
  const modal = new ModalBuilder().setCustomId(`mdl:edit:${eventId}`).setTitle(`Редактирование ${event.code}`.slice(0, 45));
  const field = (id: string, label: string, style: (typeof TextInputStyle)[keyof typeof TextInputStyle], value: string, required: boolean) =>
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setValue(value.slice(0, 900)).setRequired(required)
    );
  const d = event.scheduledAt;
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  modal.addComponents(
    field("title", "Название", TextInputStyle.Short, event.title, true),
    field("description", "Описание", TextInputStyle.Paragraph, event.description, true),
    field("date", "Дата (ДД.ММ.ГГГГ)", TextInputStyle.Short, `${dd}.${mm}.${d.getFullYear()}`, true),
    field("time", "Время (ЧЧ:ММ)", TextInputStyle.Short, `${hh}:${mi}`, true),
    field("location", "Место", TextInputStyle.Short, event.location ?? "", false)
  );
  return modal;
}

export function reasonModal(kind: "reject" | "revision", eventId: number, title: string): ModalBuilder {  const modal = new ModalBuilder().setCustomId(`mdl:reason:${kind}:${eventId}`).setTitle(title.slice(0, 45));
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("reason")
        .setLabel("Причина (обязательно)")
        .setStyle(TextInputStyle.Paragraph)
        .setMinLength(5)
        .setMaxLength(900)
        .setPlaceholder("Опишите причину решения — она будет отправлена автору заявки")
        .setRequired(true)
    )
  );
  return modal;
}

export function reportModal(eventId: number): ModalBuilder {
  const modal = new ModalBuilder().setCustomId(`mdl:report:${eventId}`).setTitle("Отчёт по МП — шаг 1");
  const field = (
    id: string,
    label: string,
    style: (typeof TextInputStyle)[keyof typeof TextInputStyle],
    required: boolean,
    placeholder: string,
    maxLength = 900
  ) =>
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(required).setPlaceholder(placeholder).setMaxLength(maxLength)
    );
  modal.addComponents(
    field("participants", "Участников фактически", TextInputStyle.Short, true, "например 18", 6),
    field("duration", "Фактическое время (минут)", TextInputStyle.Short, true, "например 75", 6),
    field("result", "Результат", TextInputStyle.Paragraph, true, "Как прошло мероприятие?", 900),
    field("problems", "Проблемы", TextInputStyle.Paragraph, false, "Что пошло не так (если было)", 900),
    field("comment", "Комментарий", TextInputStyle.Paragraph, false, "Свободный комментарий", 900)
  );
  return modal;
}

export function reportModalStep2(): ModalBuilder {
  const modal = new ModalBuilder().setCustomId("mdl:report2").setTitle("Отчёт по МП — шаг 2");
  const field = (id: string, label: string, placeholder: string, required: boolean) =>
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(TextInputStyle.Paragraph).setRequired(required).setPlaceholder(placeholder).setMaxLength(900)
    );
  modal.addComponents(
    field("suggestions", "Предложения", "Что улучшить в следующий раз", false),
    field("materials", "Дополнительные материалы", "Ссылки на скриншоты, записи и т.п.", false)
  );
  return modal;
}

export function applicationModalStep2(): ModalBuilder {
  const modal = new ModalBuilder().setCustomId("mdl:app2").setTitle("Заявка на МП — шаг 2");
  const field = (id: string, label: string, style: (typeof TextInputStyle)[keyof typeof TextInputStyle], required: boolean, placeholder: string, maxLength = 900) =>
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(required).setPlaceholder(placeholder).setMaxLength(maxLength)
    );
  modal.addComponents(
    field("rules", "Правила", TextInputStyle.Paragraph, false, "Правила проведения мероприятия", 900),
    field("duration", "Продолжительность (минут)", TextInputStyle.Short, true, "например 90", 6),
    field("participants", "Количество участников", TextInputStyle.Short, true, "например 24", 6),
    field("extra", "Дополнительная информация", TextInputStyle.Paragraph, false, "Что ещё важно знать", 900)
  );
  return modal;
}

export function continueButton(customId: string, label: string, emoji: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(customId).setLabel(label).setEmoji(emoji).setStyle(ButtonStyle.Primary)
  );
}

export async function showCategorySelect(interaction: ButtonInteraction | ChatInputCommandInteraction): Promise<void> {
  const categories = await prisma.eventCategory.findMany({
    where: { guildId: interaction.guildId!, active: true },
    orderBy: { name: "asc" },
  });
  if (categories.length === 0) throw new UserError("Категории МП не настроены. Выполните /setup.");

  const select = new StringSelectMenuBuilder()
    .setCustomId("app:cat")
    .setPlaceholder("Выберите категорию мероприятия")
    .addOptions(
      categories.slice(0, 25).map((c) =>
        new StringSelectMenuOptionBuilder().setLabel(c.name).setValue(String(c.id)).setEmoji(c.emoji)
      )
    );

  await interaction.reply({
    embeds: [withFooter(infoEmbed("🎭 Категория мероприятия", "Выберите категорию — после этого откроется форма заявки."))],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
    flags: MessageFlags.Ephemeral,
  });
}

async function showAssignSelect(interaction: ButtonInteraction, eventId: number, code: string): Promise<void> {
  const organizers = await prisma.user.findMany({
    where: { position: { in: ["ASSISTANT", "ORGANIZER", "SENIOR", "HEAD"] }, leftAt: null },
    take: 25,
  });
  if (organizers.length === 0) {
    throw new UserError("В БД нет сотрудников с должностью организатора. Назначьте должности через /promote.");
  }
  const select = new StringSelectMenuBuilder()
    .setCustomId(`sel:assign:${eventId}`)
    .setPlaceholder("Выберите организатора мероприятия")
    .addOptions(organizers.map((o) => new StringSelectMenuOptionBuilder().setLabel(o.nickname ?? o.username).setValue(o.discordId)));
  await interaction.reply({
    embeds: [withFooter(infoEmbed(`👤 Назначение организатора — ${code}`, "Выберите сотрудника из списка (состав берётся из БД)."))],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
    flags: MessageFlags.Ephemeral,
  });
}

export { ButtonBuilder, ButtonStyle };
