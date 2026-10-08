import { REST, Routes, type Client, type RESTPostAPIApplicationCommandsJSONBody } from "discord.js";
import { commands } from "../commands";
import { config } from "../config";
import { logger } from "../lib/logger";

/// Рекурсивная сериализация с сортировкой ключей: позволяет сравнивать
/// payload независимо от порядка свойств, который Discord возвращает иначе,
/// чем собирает builders.
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/// Нормализация опций: Discord не возвращает `required: false`
/// (false — значение по умолчанию) и не возвращает пустой список
/// `options` у подкоманд — сравниваем без этих полей.
function normalizeOptions(raw: unknown): unknown {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    if (!item || typeof item !== "object") return item;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(item as Record<string, unknown>)) {
      if (value === undefined) continue;
      if (key === "required" && value === false) continue;
      if (key === "options" && Array.isArray(value) && value.length === 0) continue;
      out[key] = key === "options" ? normalizeOptions(value) : value;
    }
    return out;
  });
}

/// Каноничное представление команды: только те поля, которые мы контролируем.
/// Неизвестные/возвращаемые Discord поля (dm_permission, nsfw, id, version)
/// сознательно исключаются — иначе сравнение всегда давало бы расхождение.
function canonical(raw: unknown): string {
  const json = raw as Record<string, unknown>;
  return stable({
    name: json.name,
    description: json.description,
    options: normalizeOptions(json.options ?? []),
    default_member_permissions: json.default_member_permissions ?? null,
  });
}

function buildPayloads(): RESTPostAPIApplicationCommandsJSONBody[] {
  return commands.map((c) => c.data.toJSON() as RESTPostAPIApplicationCommandsJSONBody);
}

/// Discord требует, чтобы обязательные опции шли раньше необязательных.
/// Проверяем это до отправки, чтобы ошибка была понятной, а не в виде
/// «Invalid Form Body» от API.
function validateOptionOrder(payloads: RESTPostAPIApplicationCommandsJSONBody[]): void {
  const issues: string[] = [];
  type Opt = { type?: number; name: string; required?: boolean; options?: Opt[] };

  const check = (opts: Opt[] | undefined, where: string): void => {
    if (!opts) return;
    let seenOptional = false;
    for (const opt of opts) {
      if (opt.type === 1 || opt.type === 2) {
        check(opt.options, `${where} → ${opt.name}`);
        continue;
      }
      if (opt.required === false) {
        seenOptional = true;
      } else if (opt.required === true && seenOptional) {
        issues.push(`${where}: обязательная опция «${opt.name}» идёт после необязательных`);
      }
    }
  };

  for (const payload of payloads) check(payload.options as Opt[] | undefined, `команда /${payload.name}`);
  if (issues.length > 0) {
    throw new Error(`Некорректный порядок опций команд:\n  - ${issues.join("\n  - ")}`);
  }
}

/// Сравнивает текущие зарегистрированные команды с локальным реестром
/// и перерегистрирует их только при расхождении (экономит rate limit Discord).
/// Сравнение — по имени команды (порядок в Discord не гарантируется).
async function syncCommands(
  fetchExisting: () => Promise<unknown[]>,
  push: (payloads: RESTPostAPIApplicationCommandsJSONBody[]) => Promise<unknown>,
  scopeLabel: string
): Promise<void> {
  const payloads = buildPayloads();
  validateOptionOrder(payloads);
  const wanted = new Map(payloads.map((p) => [p.name, canonical(p)]));

  let existing: unknown[] = [];
  try {
    existing = await fetchExisting();
  } catch (err) {
    logger.warn(`Не удалось получить зарегистрированные команды (${scopeLabel}):`, err);
  }

  const current = new Map(existing.map((e) => [(e as { name?: string }).name ?? "", canonical(e)]));
  const unchanged =
    existing.length > 0 &&
    existing.length === wanted.size &&
    [...wanted].every(([name, value]) => current.get(name) === value);

  if (unchanged) {
    logger.info(`Команды (${scopeLabel}) уже актуальны — ${payloads.length} шт., без изменений`);
    return;
  }

  await push(payloads);
  logger.info(`Команды зарегистрированы (${scopeLabel}): ${payloads.length} шт.`);
}

/// Сырые payload'ы из REST (тот же формат, что мы отправляем) — объекты
/// ApplicationCommand из discord.js нормализуют поля иначе (maxLength,
/// пустые options), из-за чего сравнение давало бы ложные расхождения.
/// Регистрирует команды на всех настроенных серверах: GUILD_ID (сервер
/// организаторов) и OFFICIAL_GUILD_ID (официальный сервер, где проходят МП).
/// Глобальная регистрация — запасной вариант, если ни один guild не доступен.
export async function registerCommands(client: Client): Promise<void> {
  try {
    validateOptionOrder(buildPayloads());
    const appId = client.application?.id;
    if (!appId) throw new Error("application недоступен — регистрация возможна только после события ClientReady.");
    const rest = new REST({ version: "10" }).setToken(config.discordToken);

    const guildIds = [...new Set([config.guildId, config.officialGuildId].filter((id): id is string => Boolean(id)))];
    let registeredOnGuild = false;

    for (const guildId of guildIds) {
      try {
        const guild = await client.guilds.fetch(guildId);
        await syncCommands(
          async () => (await rest.get(Routes.applicationGuildCommands(appId, guild.id))) as unknown[],
          async (payloads) => guild.commands.set(payloads),
          `сервер ${guild.name}`
        );
        registeredOnGuild = true;
      } catch (err) {
        logger.warn(
          `Не удалось зарегистрировать команды на сервере ${guildId} (бот не приглашён, неверный ID или ошибка payload). ` +
            `Проверьте GUILD_ID/OFFICIAL_GUILD_ID в .env.`
        );
        logger.warn(String(err));
      }
    }
    if (registeredOnGuild) return;

    await syncCommands(
      async () => (await rest.get(Routes.applicationCommands(appId))) as unknown[],
      async (payloads) => client.application!.commands.set(payloads),
      "глобально"
    );
  } catch (err) {
    logger.error("Не удалось зарегистрировать команды:", err);
  }
}
