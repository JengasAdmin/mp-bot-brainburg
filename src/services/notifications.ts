import { type Client, type EmbedBuilder, type Snowflake } from "discord.js";
import { logger } from "../lib/logger";

/// Уведомления пользователям в личные сообщения.
/// Анти-спам: без повторов одного и того же текста в течение короткого окна.
const recentSends = new Map<string, number>();
const DEDUPE_MS = 60_000;

export async function notifyUser(
  client: Client,
  userId: Snowflake,
  embed: EmbedBuilder
): Promise<boolean> {
  const key = `${userId}:${embed.data.title ?? ""}`;
  const last = recentSends.get(key);
  const now = Date.now();
  if (last && now - last < DEDUPE_MS) return false;
  recentSends.set(key, now);

  try {
    const user = await client.users.fetch(userId);
    await user.send({ embeds: [embed] });
    return true;
  } catch (err) {
    // ЛС закрыто — это нормальная ситуация, не ошибка системы.
    logger.debug(`Не удалось отправить ЛС пользователю ${userId}:`, err);
    return false;
  }
}

export function cleanupDedupe(): void {
  const now = Date.now();
  for (const [key, ts] of recentSends) {
    if (now - ts > DEDUPE_MS * 10) recentSends.delete(key);
  }
}
