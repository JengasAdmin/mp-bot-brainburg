import {
  ActionRowBuilder,
  MessageFlags,
  type ModalSubmitInteraction,
} from "discord.js";
import { UserError } from "../lib/errors";
import { successEmbed, withFooter } from "../lib/embeds";
import { ephemeral, requireContext, requirePermission, safeExecute } from "./shared";
import { setDraft, takeDraft } from "./drafts";
import { createApplication, loadEvent, rejectEvent, requestRevision, resubmitEvent, refreshEventViews } from "../services/events";
import { EDITABLE_STATUSES, assertFutureDate } from "../services/rules";
import { assertNoScheduleConflict } from "../services/schedule";
import { hasAtLeast } from "../permissions/matrix";
import { createReport } from "../services/reports";
import { prisma } from "../lib/db";
import { STATUS_RU } from "../constants";
import { writeAudit } from "../services/audit";

export async function handleModal(interaction: ModalSubmitInteraction): Promise<void> {
  const parts = interaction.customId.split(":");
  const [namespace, action, ...rest] = parts;
  if (namespace !== "mdl") return;

  await safeExecute(interaction, async () => {
    switch (action) {
      case "app1": {
        const ctx = await requireContext(interaction);
        await requirePermission(ctx, "CREATE_APPLICATION");
        const categoryId = Number(rest[0]);
        const draft = readFields(interaction, ["title", "description", "date", "time", "location"]);
        const { parseDateTime } = await import("../lib/time");
        parseDateTime(draft.date, draft.time);
        setDraft(`app:${interaction.user.id}`, { ...draft, categoryId });
        const { continueButton } = await import("./buttons");
        await interaction.reply({
          embeds: [withFooter(successEmbed("✅ Шаг 1 сохранён", "Нажмите кнопку ниже, чтобы заполнить оставшиеся поля заявки."))],
          components: [continueButton("app:step2", "Продолжить заполнение", "➡️")],
          flags: MessageFlags.Ephemeral,
        });
        break;
      }
      case "app2": {
        const ctx = await requireContext(interaction);
        await requirePermission(ctx, "CREATE_APPLICATION");
        const first = takeDraft(`app:${interaction.user.id}`);
        if (!first) throw new UserError("Время ожидания истекло. Нажмите «Создать МП» заново.");
        const second = readFields(interaction, ["rules", "duration", "participants", "extra"]);
        const event = await createApplication(interaction.client, ctx.guildId, interaction.user, {
          title: String(first.title),
          categoryId: Number(first.categoryId),
          description: String(first.description),
          rules: second.rules || undefined,
          dateStr: String(first.date),
          timeStr: String(first.time),
          durationMinutes: Number(second.duration) > 0 ? Math.min(Number(second.duration), 1440) : 60,
          participantsPlanned: Number(second.participants) > 0 ? Math.min(Number(second.participants), 10000) : 20,
          location: String(first.location ?? "") || undefined,
          extraInfo: String(second.extra ?? "") || undefined,
        });
        await ephemeral(interaction, {
          embeds: [
            withFooter(
              successEmbed(
                "📨 Заявка создана",
                `Мероприятию присвоен ID **${event.code}**.\nОно отправлено на проверку: <#${ctx.settings.reviewChannelId}>.`
              )
            ),
          ],
        });
        break;
      }
      case "reason": {
        const ctx = await requireContext(interaction);
        await requirePermission(ctx, "REVIEW");
        const kind = rest[0];
        const event = await loadEvent(Number(rest[1]));
        const reason = interaction.fields.getTextInputValue("reason").trim();
        if (reason.length < 5) throw new UserError("Причина слишком короткая (минимум 5 символов).");
        if (kind === "reject") {
          await rejectEvent(interaction.client, event, interaction.user, reason);
        } else if (kind === "revision") {
          await requestRevision(interaction.client, event, interaction.user, reason);
        } else {
          throw new UserError("Неизвестный тип решения.");
        }
        const meta = STATUS_RU[kind === "reject" ? "REJECTED" : "REVISION"];
        await ephemeral(interaction, {
          embeds: [withFooter(successEmbed(`${meta.emoji} Готово`, `${event.code} — статус «${meta.label}». Автор уведомлён в ЛС.`))],
        });
        break;
      }
      case "report": {
        await requireContext(interaction);
        const event = await loadEvent(Number(rest[0]));
        if (event.status !== "COMPLETED") throw new UserError("Отчёт создаётся после завершения МП.");
        const fields = readFields(interaction, ["participants", "duration", "result", "problems", "comment"]);
        if (!/^\d+$/.test(fields.participants) || !/^\d+$/.test(fields.duration)) {
          throw new UserError("Участники и время указываются целым числом.");
        }
        setDraft(`report:${interaction.user.id}`, { ...fields, eventId: event.id });
        const { continueButton } = await import("./buttons");
        await interaction.reply({
          embeds: [withFooter(successEmbed("✅ Шаг 1 сохранён", "Нажмите кнопку ниже, чтобы дополнить отчёт (необязательно) и отправить."))],
          components: [continueButton("ev:report2", "Продолжить", "➡️")],
          flags: MessageFlags.Ephemeral,
        });
        break;
      }
      case "report2": {
        await requireContext(interaction);
        const first = takeDraft(`report:${interaction.user.id}`);
        if (!first) throw new UserError("Время ожидания истекло. Создайте отчёт заново.");
        const second = readFields(interaction, ["suggestions", "materials"]);
        await createReport(interaction.client, Number(first.eventId), interaction.user, {
          participantsActual: Number(first.participants),
          durationActualMinutes: Number(first.duration),
          result: String(first.result),
          problems: String(first.problems ?? "") || undefined,
          comment: String(first.comment ?? "") || undefined,
          suggestions: String(second.suggestions ?? "") || undefined,
          materials: String(second.materials ?? "") || undefined,
        });

        // Сверка с фактической посещаемостью голосового канала.
        const { getAttendance } = await import("../services/attendance");
        const attended = (await getAttendance(Number(first.eventId))).length;
        const reported = Number(first.participants);
        let note = "Отчёт сохранён в БД. Мероприятие готово к архивированию.";
        if (attended > 0) {
          note += `\n\n🎙 По голосовому каналу зафиксировано: **${attended} чел.** (в отчёте указано ${reported}).`;
          if (reported > attended + Math.max(2, Math.round(attended * 0.3))) {
            note += "\n⚠️ Расхождение больше 30% — проверяющий увидит сводку посещаемости при проверке отчёта.";
          }
        }
        await ephemeral(interaction, { embeds: [withFooter(successEmbed("📋 Отчёт сдан", note))] });
        break;
      }
      case "mat": {
        const ctx = await requireContext(interaction);
        await requirePermission(ctx, "CREATE_APPLICATION");
        const draft = takeDraft(`mat:${interaction.user.id}`);
        if (!draft) throw new UserError("Время ожидания истекло. Выполните /material add заново.");
        const body = interaction.fields.getTextInputValue("body");
        const { createMaterial } = await import("../services/materials");
        const material = await createMaterial(ctx.guildId, interaction.user.id, {
          title: String(draft.title ?? ""),
          body,
          tags: String(draft.tags ?? ""),
          categoryId: draft.categoryId ? Number(draft.categoryId) : null,
        });
        await ephemeral(interaction, {
          embeds: [
            successEmbed(
              "📚 Материал создан",
              `**#${material.id} ${material.title}** — прикрепляйте к МП через \`/material attach\`, ищите через \`/material list\`.`
            ),
          ],
        });
        break;
      }
      case "edit": {
        const ctx = await requireContext(interaction);
        const event = await loadEvent(Number(rest[0]));
        if (event.authorId !== interaction.user.id && !hasAtLeast(ctx.position, "SENIOR")) {
          throw new UserError("Редактировать заявку может только её автор или руководство.");
        }
        if (!EDITABLE_STATUSES.includes(event.status)) {
          throw new UserError(`Заявка в статусе «${STATUS_RU[event.status]?.label ?? event.status}» не редактируется.`);
        }
        const fields = readFields(interaction, ["title", "description", "date", "time", "location"]);
        const { parseDateTime } = await import("../lib/time");
        const scheduledAt = parseDateTime(fields.date, fields.time);
        assertFutureDate(scheduledAt);
        // Защита от двойных броней: новое время не должно пересекаться с другими МП.
        await assertNoScheduleConflict(event.guildId, scheduledAt, event.durationMinutes, event.id);
        await prisma.event.update({
          where: { id: event.id },
          data: { title: fields.title, description: fields.description, scheduledAt, location: fields.location || null },
        });
        await writeAudit(interaction.client, {
          guildId: ctx.guildId,
          action: "EVENT_UPDATED",
          actorId: interaction.user.id,
          actorTag: interaction.user.tag,
          targetType: "event",
          targetId: event.code,
          newValue: "Отредактировано",
        });
        const fresh = await loadEvent(event.id);
        if (event.status === "REVISION") {
          await resubmitEvent(interaction.client, fresh, interaction.user);
          await ephemeral(interaction, { embeds: [withFooter(successEmbed("✏️ Изменено и отправлено", `${event.code} отправлено на повторную проверку.`))] });
        } else {
          await refreshEventViews(interaction.client, fresh);
          await ephemeral(interaction, { embeds: [withFooter(successEmbed("✏️ Заявка обновлена", `${event.code} — изменения сохранены.`))] });
        }
        break;
      }
      default:
        throw new UserError("Неизвестная форма.");
    }
  });
}

function readFields(interaction: ModalSubmitInteraction, ids: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of ids) {
    out[id] = (interaction.fields.getTextInputValue(id) ?? "").trim();
  }
  return out;
}
