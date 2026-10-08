import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Partials,
} from "discord.js";
import { config } from "./config";
import { logger } from "./lib/logger";
import { disconnectDb, prisma } from "./lib/db";
import { getCommand } from "./commands";
import { registerCommands } from "./discord/registerCommands";
import { handleButton } from "./interactions/buttons";
import { handleModal } from "./interactions/modals";
import { handleSelect } from "./interactions/selects";
import { safeExecute } from "./interactions/shared";
import { UserError } from "./lib/errors";
import { errorEmbed } from "./lib/embeds";
import { startScheduler, stopScheduler } from "./scheduler";
import { runRecovery } from "./scheduler/recovery";
import { handleVoiceStateUpdate } from "./services/attendance";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.Channel, Partials.GuildMember],
});

client.once(Events.ClientReady, async (ready) => {
  logger.info(`Бот запущен: ${ready.user.tag} (${ready.user.id})`);

  // Регистрация slash-команд (сравнение с уже зарегистрированными).
  await registerCommands(ready);

  // Проверка связи с БД.
  try {
    await prisma.$queryRaw`SELECT 1`;
    logger.info("База данных доступна");
  } catch (err) {
    logger.error("База данных недоступна — выполните npm run db:push:", err);
    return;
  }

  // Восстановление после рестарта (каналы, панели, первый тик планировщика)
  // и запуск планировщика. Идемпотентно — повторный ready не задвоит работу.
  startScheduler(ready);
  await runRecovery(ready);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const command = getCommand(interaction.commandName);
      if (!command) {
        await interaction
          .reply({ embeds: [errorEmbed("❌ Неизвестная команда", "Эта команда ещё не реализована.")], flags: MessageFlags.Ephemeral })
          .catch(() => undefined);
        return;
      }
      await safeExecute(interaction, () => command.execute(interaction, client));
      return;
    }

    if (interaction.isAutocomplete()) {
      const command = getCommand(interaction.commandName);
      if (!command?.autocomplete) return;
      try {
        await command.autocomplete(interaction);
      } catch (err) {
        logger.error(`Autocomplete для ${interaction.commandName} не удался:`, err);
        await interaction.respond([]).catch(() => undefined);
      }
      return;
    }

    if (interaction.isButton()) {
      await handleButton(interaction);
      return;
    }
    if (interaction.isAnySelectMenu()) {
      await handleSelect(interaction);
      return;
    }
    if (interaction.isModalSubmit()) {
      await handleModal(interaction);
      return;
    }
  } catch (err) {
    // Аварийный контур: safeExecute уже перехватывает ошибки, сюда доходит
    // только сбой самого механизма маршрутизации.
    logger.error("Критическая ошибка маршрутизации интеракции:", err);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      const message = err instanceof UserError ? err.message : "Внутренняя ошибка. Информация записана в журнал.";
      await interaction
        .reply({ embeds: [errorEmbed("❌ Ошибка", message)], flags: MessageFlags.Ephemeral })
        .catch(() => undefined);
    }
  }
});

// Учёт посещаемости МП: вход/выход из голосовых каналов мероприятий.
client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  void handleVoiceStateUpdate(oldState, newState);
});

// Периодическое освобождение памяти от черновиков и дедупликации уведомлений.
setInterval(() => {
  import("./interactions/drafts").then((m) => m.cleanupDrafts()).catch(() => undefined);
  import("./services/notifications").then((m) => m.cleanupDedupe()).catch(() => undefined);
}, 10 * 60_000).unref();

async function shutdown(signal: string): Promise<void> {
  logger.info(`Получен сигнал ${signal}, корректное завершение работы…`);
  try {
    stopScheduler();
    await client.destroy();
    await disconnectDb();
    logger.info("Работа завершена.");
    process.exit(0);
  } catch (err) {
    logger.error("Ошибка при завершении работы:", err);
    process.exit(1);
  }
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("unhandledRejection", (reason) => logger.error("unhandledRejection:", reason));
process.on("uncaughtException", (err) => logger.error("uncaughtException:", err));

client.login(config.discordToken).catch((err) => {
  logger.error("Не удалось войти в Discord. Проверьте DISCORD_TOKEN в .env:", err);
  process.exit(1);
});
