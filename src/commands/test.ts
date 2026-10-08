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
