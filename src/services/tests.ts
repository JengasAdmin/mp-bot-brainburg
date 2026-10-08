import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type Client,
  type User,
} from "discord.js";
import { prisma } from "../lib/db";
import { UserError } from "../lib/errors";
import { baseEmbed, errorEmbed, successEmbed, COLORS } from "../lib/embeds";
import { writeAudit } from "../services/audit";
import { computeTestScore } from "./rules";
import { logger } from "../lib/logger";

const ANSWER_PREFIX = "tst:a";
const ATTEMPT_TTL_MIN = 60;

export interface TestQuestionView {
  id: number;
  text: string;
  options: string[];
  correctIndex: number;
}

function parseQuestions(questionIds: string): number[] {
  const arr = JSON.parse(questionIds) as number[];
  if (!Array.isArray(arr)) throw new UserError("Повреждена структура попытки.");
  return arr;
}

function shuffle<T>(arr: T[]): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export async function listActiveTests(guildId: string) {
  return prisma.test.findMany({ where: { guildId, active: true }, orderBy: { id: "asc" } });
}

/// Начинает попытку: случайный вариант из вопросов БД, лимит попыток соблюдается.
export async function startTest(
  client: Client,
  guildId: string,
  testId: number,
  user: User
): Promise<void> {
  const test = await prisma.test.findUnique({ where: { id: testId } });
  if (!test || !test.active || test.guildId !== guildId) {
    throw new UserError("Тест не найден или отключён.");
  }

  const attemptsUsed = await prisma.testAttempt.count({
    where: { testId, userId: user.id, status: "FINISHED" },
  });
  if (attemptsUsed >= test.attemptsLimit) {
    throw new UserError(
      `Исчерпаны попытки по тесту «${test.title}» (лимит: ${test.attemptsLimit}). Обратитесь к руководству.`
    );
  }

  const inProgress = await prisma.testAttempt.findFirst({
    where: { testId, userId: user.id, status: "IN_PROGRESS" },
  });
  if (inProgress) {
    throw new UserError("У вас уже есть незавершённая попытка этого теста. Завершите её или дождитесь её истечения.");
  }

  const questions = await prisma.testQuestion.findMany({ where: { testId, active: true } });
  if (questions.length === 0) throw new UserError("В тесте пока нет вопросов.");

  const variant = shuffle(questions.map((q) => q.id));
  const attempt = await prisma.testAttempt.create({
    data: {
      testId,
      userId: user.id,
      questionIds: JSON.stringify(variant),
      total: variant.length,
    },
  });

  try {
    await sendQuestion(client, attempt.id, user);
  } catch (err) {
    // ЛС недоступно — удаляем только что созданную попытку, чтобы
    // пользователь не остался с «зависшей» попыткой без вопросов.
    await prisma.testAttempt.delete({ where: { id: attempt.id } }).catch(() => undefined);
    throw err;
  }

  await writeAudit(client, {
    guildId,
    action: "TEST_STARTED",
    actorId: user.id,
    actorTag: user.tag,
    targetType: "test",
    targetId: String(testId),
  });
}

/// Отправляет текущий вопрос попытки в эфемерном сообщении.
async function sendQuestion(client: Client, attemptId: number, user: User): Promise<void> {
  const attempt = await prisma.testAttempt.findUnique({ where: { id: attemptId } });
  if (!attempt || attempt.status !== "IN_PROGRESS") throw new UserError("Попытка не найдена или уже завершена.");

  const questionIds = parseQuestions(attempt.questionIds);
  const index = attempt.currentIndex;
  if (index >= questionIds.length) {
    await finishAttempt(client, attempt.id, user);
    return;
  }

  const question = await prisma.testQuestion.findUnique({ where: { id: questionIds[index] } });
  if (!question) throw new UserError("Вопрос теста недоступен.");

  const options = JSON.parse(question.options) as string[];
  const embed = baseEmbed(`🎓 Вопрос ${index + 1} из ${questionIds.length}`)
    .setColor(COLORS.INFO)
    .setDescription(question.text);
  embed.setFooter({ text: "Отвечайте кнопками ниже. Отменить попытку нельзя." });

  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let rowStart = 0; rowStart < options.length; rowStart += 5) {
    const row = new ActionRowBuilder<ButtonBuilder>();
    for (let i = rowStart; i < Math.min(rowStart + 5, options.length); i++) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`${ANSWER_PREFIX}:${attemptId}:${index}:${i}`)
          .setLabel(String.fromCharCode(65 + i))
          .setStyle(ButtonStyle.Secondary)
      );
    }
    rows.push(row);
  }

  const dm = await user.send({
    embeds: [embed],
    components: rows,
  }).catch(() => null);

  if (!dm) {
    throw new UserError(
      "Не удалось отправить вам личные сообщения. Откройте ЛС для пользователей этого сервера и нажмите «Начать тест» заново."
    );
  }

  await prisma.testAttempt.update({
    where: { id: attemptId },
    data: { messageChannelId: dm.channelId, messageId: dm.id },
  });
}

/// Обрабатывает ответ на вопрос. Защита от повторного нажатия — по currentIndex.
export async function handleAnswer(
  client: Client,
  attemptId: number,
  questionIndex: number,
  optionIndex: number,
  user: User
): Promise<void> {
  const attempt = await prisma.testAttempt.findUnique({ where: { id: attemptId } });
  if (!attempt) throw new UserError("Попытка не найдена.");
  if (attempt.userId !== user.id) throw new UserError("Это не ваша попытка прохождения теста.");
  if (attempt.status !== "IN_PROGRESS") throw new UserError("Эта попытка уже завершена.");
  if (attempt.currentIndex !== questionIndex) {
    throw new UserError("Вопрос уже отвечён. Используйте актуальное сообщение теста.");
  }

  const questionIds = parseQuestions(attempt.questionIds);
  if (questionIndex >= questionIds.length) throw new UserError("Некорректный индекс вопроса.");

  const answers = JSON.parse(attempt.answers) as number[];
  const nextAnswers = [...answers, optionIndex];
  await prisma.testAttempt.update({
    where: { id: attemptId },
    data: { answers: JSON.stringify(nextAnswers), currentIndex: questionIndex + 1 },
  });

  try {
    await sendQuestion(client, attemptId, user);
  } catch (err) {
    // Откатываем прогресс: без доставленного вопроса ответ не засчитывается,
    // пользователь может ответить повторно с предыдущего сообщения.
    await prisma.testAttempt
      .update({ where: { id: attemptId }, data: { answers: JSON.stringify(answers), currentIndex: questionIndex } })
      .catch(() => undefined);
    throw err;
  }
}

/// Завершает попытку: считает балл, сохраняет результат, выдаёт роль при успехе.
async function finishAttempt(client: Client, attemptId: number, user: User): Promise<void> {
  const attempt = await prisma.testAttempt.findUnique({ where: { id: attemptId }, include: { test: true } });
  if (!attempt) return;

  const questionIds = parseQuestions(attempt.questionIds);
  const answers = JSON.parse(attempt.answers) as number[];
  const questions = await prisma.testQuestion.findMany({
    where: { id: { in: questionIds } },
  });
  const byId = new Map(questions.map((q) => [q.id, q]));

  const ordered = questionIds
    .map((qid) => byId.get(qid))
    .filter((q): q is NonNullable<typeof q> => Boolean(q));
  const { correct, score, passed } = computeTestScore(ordered, answers, attempt.test.passScore);

  await prisma.testAttempt.update({
    where: { id: attemptId },
    data: { score, passed, status: "FINISHED", finishedAt: new Date(), answers: JSON.stringify(answers) },
  });

  await writeAudit(client, {
    guildId: attempt.test.guildId,
    action: "TEST_FINISHED",
    actorId: user.id,
    actorTag: user.tag,
    targetType: "test",
    targetId: attempt.test.title,
    newValue: `${score}% (${passed ? "сдан" : "не сдан"})`,
  });

  let roleNote = "";
  if (passed && attempt.test.grantRoleId) {
    try {
      const fetchedGuild = await client.guilds.fetch(attempt.test.guildId);
      const member = await fetchedGuild.members.fetch(user.id).catch(() => null);
      const role = fetchedGuild.roles.cache.get(attempt.test.grantRoleId);
      if (member && role) {
        const me = fetchedGuild.members.me;
        if (me && me.permissions.has("ManageRoles") && role.position < me.roles.highest.position) {
          await member.roles.add(role, `Успешная сдача теста «${attempt.test.title}»`);
          roleNote = `\nВыдана роль ${role}.`;
          await writeAudit(client, {
            guildId: attempt.test.guildId,
            action: "TEST_ROLE_GRANTED",
            actorId: user.id,
            actorTag: user.tag,
            targetType: "role",
            targetId: role.id,
            newValue: role.name,
          });
        } else {
          roleNote = "\n⚠️ Бот не смог выдать роль: не хватает прав (роль выше роли бота). Обратитесь к руководству.";
        }
      }
    } catch (err) {
      roleNote = "\n⚠️ Не удалось выдать роль за тест — обратитесь к руководству.";
      logger.warn(`Не удалось выдать роль за тест пользователю ${user.id}:`, err);
    }
  }

  const resultEmbed = passed
    ? successEmbed(
        `✅ Тест «${attempt.test.title}» сдан!`,
        `Результат: **${score}%** (проходной: ${attempt.test.passScore}%).\nПравильных ответов: ${correct} из ${questionIds.length}.${roleNote}`
      )
    : errorEmbed(
        `❌ Тест «${attempt.test.title}» не сдан`,
        `Результат: **${score}%** (проходной: ${attempt.test.passScore}%).\nПравильных ответов: ${correct} из ${questionIds.length}.\n\nОсталось попыток: ${Math.max(0, attempt.test.attemptsLimit - (await prisma.testAttempt.count({ where: { testId: attempt.testId, userId: user.id, status: "FINISHED" } })))}.`
      );

  await user.send({ embeds: [resultEmbed] }).catch(() => null);
}

/// Истечение зависших попыток (вызывается планировщиком).
export async function expireStaleAttempts(): Promise<number> {
  const cutoff = new Date(Date.now() - ATTEMPT_TTL_MIN * 60_000);
  const stale = await prisma.testAttempt.findMany({
    where: { status: "IN_PROGRESS", startedAt: { lt: cutoff } },
  });
  for (const attempt of stale) {
    await prisma.testAttempt.update({
      where: { id: attempt.id },
      data: { status: "FINISHED", passed: false, score: null, finishedAt: new Date() },
    });
  }
  return stale.length;
}

/// Просмотр результатов сотрудника (для команды /test results).
export async function userTestHistory(userId: string) {
  return prisma.testAttempt.findMany({
    where: { userId, status: "FINISHED" },
    include: { test: true },
    orderBy: { finishedAt: "desc" },
    take: 10,
  });
}

// ─────────────────────────── Управление тестами (TEST_MANAGE) ───────────────────────────

export interface CreateTestInput {
  title: string;
  description?: string;
  passScore: number;
  attemptsLimit: number;
  grantRoleId?: string | null;
}

export async function createTest(client: Client, guildId: string, actor: User, input: CreateTestInput) {
  if (input.title.trim().length < 3) throw new UserError("Название теста слишком короткое.");
  if (input.passScore < 1 || input.passScore > 100) throw new UserError("Проходной балл должен быть от 1 до 100.");
  if (input.attemptsLimit < 1 || input.attemptsLimit > 20) throw new UserError("Лимит попыток должен быть от 1 до 20.");

  const test = await prisma.test.create({
    data: {
      guildId,
      title: input.title.trim(),
      description: input.description?.trim() || null,
      passScore: input.passScore,
      attemptsLimit: input.attemptsLimit,
      grantRoleId: input.grantRoleId ?? null,
    },
  });

  await writeAudit(client, {
    guildId,
    action: "TEST_CREATED",
    actorId: actor.id,
    actorTag: actor.tag,
    targetType: "test",
    targetId: String(test.id),
    newValue: test.title,
  });
  return test;
}

export interface AddQuestionInput {
  testId: number;
  text: string;
  options: string[];
  correctIndex: number;
}

export async function addQuestion(client: Client, guildId: string, actor: User, input: AddQuestionInput) {
  const test = await prisma.test.findUnique({ where: { id: input.testId } });
  if (!test || test.guildId !== guildId) throw new UserError(`Тест с ID ${input.testId} не найден.`);
  if (input.text.trim().length < 5) throw new UserError("Текст вопроса слишком короткий.");
  if (input.options.length < 2) throw new UserError("Нужно минимум два варианта ответа.");
  if (input.options.length > 6) throw new UserError("Максимум 6 вариантов ответа.");
  if (input.correctIndex < 0 || input.correctIndex >= input.options.length) {
    throw new UserError("Индекс правильного ответа вне диапазона вариантов.");
  }
  if (new Set(input.options.map((o) => o.trim().toLowerCase())).size !== input.options.length) {
    throw new UserError("Варианты ответа не должны повторяться.");
  }

  const question = await prisma.testQuestion.create({
    data: {
      testId: test.id,
      text: input.text.trim(),
      options: JSON.stringify(input.options.map((o) => o.trim())),
      correctIndex: input.correctIndex,
    },
  });

  await writeAudit(client, {
    guildId,
    action: "TEST_QUESTION_ADDED",
    actorId: actor.id,
    actorTag: actor.tag,
    targetType: "test",
    targetId: String(test.id),
    newValue: input.text.slice(0, 200),
  });
  return question;
}

export async function removeQuestion(client: Client, guildId: string, actor: User, questionId: number) {
  const question = await prisma.testQuestion.findUnique({ where: { id: questionId }, include: { test: true } });
  if (!question || question.test.guildId !== guildId) throw new UserError(`Вопрос с ID ${questionId} не найден.`);
  await prisma.testQuestion.delete({ where: { id: questionId } });
  await writeAudit(client, {
    guildId,
    action: "TEST_QUESTION_REMOVED",
    actorId: actor.id,
    actorTag: actor.tag,
    targetType: "test",
    targetId: String(question.testId),
    oldValue: question.text.slice(0, 200),
  });
}

export async function setTestActive(client: Client, guildId: string, actor: User, testId: number, active: boolean) {
  const test = await prisma.test.findUnique({ where: { id: testId } });
  if (!test || test.guildId !== guildId) throw new UserError(`Тест с ID ${testId} не найден.`);
  await prisma.test.update({ where: { id: testId }, data: { active } });
  await writeAudit(client, {
    guildId,
    action: "TEST_UPDATED",
    actorId: actor.id,
    actorTag: actor.tag,
    targetType: "test",
    targetId: String(testId),
    newValue: active ? "включён" : "отключён",
  });
  return test;
}

/// Embed со списком тестов, вопросов и статистикой сдачи.
export async function testsListEmbed(guildId: string) {
  const tests = await prisma.test.findMany({ where: { guildId }, orderBy: { id: "asc" } });
  const embed = baseEmbed("🎓 Тесты").setColor(COLORS.INFO);
  if (tests.length === 0) {
    embed.setDescription("Тесты не созданы. Создайте: `/test create`.");
    return embed;
  }
  for (const t of tests) {
    const count = await prisma.testQuestion.count({ where: { testId: t.id, active: true } });
    const attempts = await prisma.testAttempt.count({ where: { testId: t.id, status: "FINISHED" } });
    embed.addFields({
      name: `#${t.id} — ${t.title}`,
      value:
        `${t.active ? "🟢 активен" : "🔴 отключён"} • вопросов: ${count} • проходной: ${t.passScore}% • попыток: ${t.attemptsLimit}\n` +
        `Сдано попыток: ${attempts}${t.description ? `\n${t.description.slice(0, 300)}` : ""}`,
    });
  }
  return embed;
}
