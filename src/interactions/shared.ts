import {
  MessageFlags,
  type BaseInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type InteractionReplyOptions,
} from "discord.js";
import { UserError } from "../lib/errors";
import { errorEmbed } from "../lib/embeds";
import { logger } from "../lib/logger";
import { getSettings } from "../services/settings";
import { syncPosition } from "../services/users";
import { describePermission, hasPermission, type Permission, type Position } from "../permissions/matrix";
import type { GuildSettings } from "@prisma/client";

/// Контекст интеракции: гильдия, настройки, должность.
export interface InteractionContext {
  client: Client;
  guildId: string;
  settings: GuildSettings;
  position: Position;
  userId: string;
}

/// Проверяет права и подготавливает контекст. Кэширует позицию в БД.
export async function requireContext(interaction: BaseInteraction): Promise<InteractionContext> {
  if (!interaction.guildId || !interaction.inGuild()) {
    throw new UserError("Это действие доступно только на сервере.");
  }
  const settings = await getSettings(interaction.guildId);
  if (!settings.setupComplete) {
    throw new UserError("Сервер ещё не настроен. Попросите главную администрацию выполнить /setup.");
  }
  const member = interaction.member as import("discord.js").GuildMember | null;
  if (!member || !("user" in member)) {
    throw new UserError("Не удалось определить участника.");
  }
  const position = await syncPosition(member, settings);
  return {
    client: interaction.client,
    guildId: interaction.guildId,
    settings,
    position,
    userId: interaction.user.id,
  };
}

export async function requirePermission(ctx: InteractionContext, permission: Permission): Promise<void> {
  if (!hasPermission(ctx.position, permission)) {
    throw new UserError(`Недостаточно прав. ${describePermission(permission)}`);
  }
}

export async function ephemeral(interaction: BaseInteraction, payload: InteractionReplyOptions): Promise<void> {
  const options = { ...payload, flags: MessageFlags.Ephemeral as never };
  if (interaction.isRepliable()) {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(options).catch(() => undefined);
    } else {
      await interaction.reply(options).catch(() => undefined);
    }
  }
}

/// Единая обработка ошибок интеракций: UserError — понятный ответ, остальное — лог.
export async function safeExecute(interaction: BaseInteraction, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof UserError) {
      await ephemeral(interaction, { embeds: [errorEmbed("❌ Ошибка", err.message)] });
    } else {
      logger.error(`Ошибка обработки интеракции ${interaction.id}:`, err);
      await ephemeral(interaction, {
        embeds: [errorEmbed("❌ Внутренняя ошибка", "Что-то пошло не так. Информация записана в журнал. Попробуйте позже.")],
      });
    }
  }
}

/// Контекст для slash-команд.
export async function commandContext(interaction: ChatInputCommandInteraction): Promise<InteractionContext> {
  return requireContext(interaction);
}
