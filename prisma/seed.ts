/**
 * Наполнение базы стартовыми справочниками (идемпотентно, только upsert):
 *  - достижения (глобальные, коды уникальны);
 *  - категории МП (для сервера из GUILD_ID);
 *  - запись настроек сервера с значениями по умолчанию.
 *
 * Никаких выдуманных сотрудников, мероприятий или статистики здесь нет —
 * реальные данные создаются только командами бота.
 *
 * Запуск: npm run seed
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { DEFAULT_ACHIEVEMENTS, DEFAULT_EVENT_CATEGORIES } from "../src/constants";

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const guildId = process.env.GUILD_ID?.trim() || null;

  let achievements = 0;
  for (const a of DEFAULT_ACHIEVEMENTS) {
    await prisma.achievement.upsert({
      where: { code: a.code },
      create: { ...a },
      update: { active: true },
    });
    achievements++;
  }
  console.log(`Достижений: ${achievements} (upsert)`);

  if (!guildId) {
    console.log("GUILD_ID не задан — категории МП и настройки сервера пропущены.");
    console.log("Задайте GUILD_ID в .env и повторите запуск, либо выполните /setup в Discord.");
    return;
  }

  let categories = 0;
  for (const cat of DEFAULT_EVENT_CATEGORIES) {
    await prisma.eventCategory.upsert({
      where: { guildId_name: { guildId, name: cat.name } },
      create: { guildId, name: cat.name, emoji: cat.emoji },
      update: { active: true },
    });
    categories++;
  }
  console.log(`Категорий МП: ${categories} (upsert)`);

  const settings = await prisma.guildSettings.upsert({
    where: { guildId },
    create: { guildId },
    update: {},
  });
  console.log(
    `Настройки сервера ${guildId}: setupComplete=${settings.setupComplete}` +
      (settings.setupComplete ? "" : " — выполните /setup в Discord для создания структуры каналов и ролей.")
  );
}

main()
  .catch((err) => {
    console.error("Seed не выполнен:", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
