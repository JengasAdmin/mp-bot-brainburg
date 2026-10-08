/// Константы системы: статусы, цвета, определения ролей/каналов для /setup.

export const STATUS = {
  DRAFT: "DRAFT",
  PENDING: "PENDING",
  REVISION: "REVISION",
  APPROVED: "APPROVED",
  PLANNED: "PLANNED",
  ACTIVE: "ACTIVE",
  COMPLETED: "COMPLETED",
  REPORTED: "REPORTED",
  ARCHIVED: "ARCHIVED",
  REJECTED: "REJECTED",
  CANCELLED: "CANCELLED",
} as const;
export type EventStatus = keyof typeof STATUS;

export const STATUS_RU: Record<string, { label: string; emoji: string; color: number }> = {
  DRAFT:     { label: "Черновик",        emoji: "📝", color: 0x9e9e9e },
  PENDING:   { label: "На проверке",     emoji: "🟡", color: 0xffd54f },
  REVISION:  { label: "На доработке",    emoji: "✏️", color: 0xffa726 },
  APPROVED:  { label: "Одобрено",        emoji: "✅", color: 0x66bb6a },
  PLANNED:   { label: "Запланировано",   emoji: "📅", color: 0x42a5f5 },
  ACTIVE:    { label: "Проводится",      emoji: "🎯", color: 0x26a69a },
  COMPLETED: { label: "Завершено",       emoji: "🏁", color: 0x8d9aa8 },
  REPORTED:  { label: "Отчёт сдан",      emoji: "📋", color: 0x26c6da },
  ARCHIVED:  { label: "В архиве",        emoji: "🗃️", color: 0x546e7a },
  REJECTED:  { label: "Отклонено",       emoji: "❌", color: 0xef5350 },
  CANCELLED: { label: "Отменено",        emoji: "🚫", color: 0x8d6e63 },
};

export const COLORS = {
  BRAND: 0xffd700,
  DARK: 0x151922,
  SURFACE: 0x1b202b,
  TEXT_MUTED: 0x8b93a1,
  SUCCESS: 0x66bb6a,
  DANGER: 0xef5350,
  WARNING: 0xffa726,
  INFO: 0x42a5f5,
};

/// Роли отдела в порядке иерархии (сверху вниз). position — смещение в иерархии Discord.
export const ROLE_DEFS = [
  { key: "roleMainAdminId",   name: "Главная Администрация",  color: "#E53935", hoist: true },
  { key: "roleCuratorId",     name: "Куратор",                color: "#7E57C2", hoist: true },
  { key: "roleHeadOrganizerId", name: "Главный Организатор МП", color: "#FFD700", hoist: true },
  { key: "roleSeniorOrganizerId", name: "Старший Организатор МП", color: "#FF8C00", hoist: true },
  { key: "roleOrganizerId",   name: "Организатор МП",         color: "#2196F3", hoist: true },
  { key: "roleAssistantId",   name: "Помощник Организаторов", color: "#43A047", hoist: false },
  { key: "roleTestPassedId",  name: "Пройденный тест",        color: "#00ACC1", hoist: false },
  { key: "roleTestAccessId",  name: "Доступ к тесту",         color: "#78909C", hoist: false },
  { key: "roleDostupId",      name: "dostup",                 color: "#607D8B", hoist: false },
  { key: "roleBotId",         name: "MP Организатор",         color: "#424242", hoist: true },
] as const;

export type RoleKey = (typeof ROLE_DEFS)[number]["key"];

/// Определения каналов: категория → каналы.
/// kind влияет на permission-матрицу (см. permissions/channelAccess.ts).
export const CATEGORY_DEFS = [
  {
    name: "📌 INFORMATION",
    emoji: "📌",
    access: "public" as const,
    channels: [
      { key: "announcementsChannelId", name: "📢・объявления", kind: "announcements", kindName: "Текстовый", topic: "Официальные объявления отдела." },
      { key: "announceChannelId", name: "📣・анонсы-мп", kind: "announcements", kindName: "Текстовый", topic: "Анонсы МП для участников: записи «Буду», старт и завершение (тест моста в официальный сервер)." },
      { key: "rulesChannelId", name: "📜・правила", kind: "readonly", kindName: "Текстовый", topic: "Правила отдела организаторов МП." },
      { key: "regulationsChannelId", name: "📚・регламент", kind: "readonly", kindName: "Текстовый", topic: "Полный рабочий регламент отдела." },
      { key: "learningChannelId", name: "📖・обучение", kind: "readonly", kindName: "Текстовый", topic: "Материалы для обучения сотрудников." },
      { key: "faqChannelId", name: "❓・faq", kind: "readonly", kindName: "Текстовый", topic: "Часто задаваемые вопросы." },
    ],
  },
  {
    name: "💡 РАБОТА С МП",
    emoji: "💡",
    access: "work" as const,
    channels: [
      { key: "ideasChannelId", name: "💡・идеи-мп", kind: "ideas", kindName: "Текстовый", topic: "Предложите идею мероприятия через кнопку «Создать заявку»." },
      { key: "applicationsChannelId", name: "📝・заявки-на-мп", kind: "applications", kindName: "Текстовый", topic: "Подача заявок на проведение МП." },
      { key: "reviewChannelId", name: "🔍・проверка-мп", kind: "review", kindName: "Текстовый", topic: "Очередь проверки заявок. Только руководство." },
      { key: "planningChannelId", name: "📅・планирование", kind: "board", kindName: "Текстовый", topic: "Календарь запланированных мероприятий." },
      { key: "activeChannelId", name: "🎯・активные-мп", kind: "board", kindName: "Текстовый", topic: "Текущие проводимые мероприятия." },
    ],
  },
  {
    name: "🎭 КАТЕГОРИИ МП",
    emoji: "🎭",
    access: "public" as const,
    channels: [
      { key: null, name: "🎭・мафия", kind: "category-chat", kindName: "Текстовый", topic: "Мероприятия по категории «Мафия»." },
      { key: null, name: "🎨・рисовалки", kind: "category-chat", kindName: "Текстовый", topic: "Мероприятия по категории «Рисовалки»." },
      { key: null, name: "🧩・отгадай", kind: "category-chat", kindName: "Текстовый", topic: "Мероприятия по категории «Отгадай»." },
      { key: null, name: "🏆・конкурсы", kind: "category-chat", kindName: "Текстовый", topic: "Конкурсы и турниры." },
      { key: null, name: "🎲・другое", kind: "category-chat", kindName: "Текстовый", topic: "Прочие мероприятия." },
      { key: null, name: "📦・шаблоны-мп", kind: "readonly", kindName: "Текстовый", topic: "Шаблоны сценариев мероприятий." },
    ],
  },
  {
    name: "📈 ОТЧЁТНОСТЬ",
    emoji: "📈",
    access: "staff" as const,
    channels: [
      { key: "statsChannelId", name: "📈・статистика", kind: "stats", kindName: "Текстовый", topic: "Статистика отдела (обновляется ботом)." },
      { key: "achievementsChannelId", name: "🏆・достижения", kind: "staff", kindName: "Текстовый", topic: "Достижения сотрудников." },
    ],
  },
  {
    name: "👥 КАДРЫ",
    emoji: "👥",
    access: "staff" as const,
    channels: [
      { key: "rosterChannelId", name: "👤・состав", kind: "roster", kindName: "Текстовый", topic: "Текущий состав отдела." },
      { key: "internshipChannelId", name: "📝・стажировка", kind: "staff", kindName: "Текстовый", topic: "Работа помощников и стажировка." },
      { key: "testingChannelId", name: "🎓・тестирование", kind: "testing", kindName: "Текстовый", topic: "Начать тест: кнопка ниже." },
      { key: "promotionsChannelId", name: "⭐・повышения", kind: "promotions", kindName: "Текстовый", topic: "Кадровые решения: повышения и понижения." },
      { key: "disciplineChannelId", name: "⚠️・дисциплина", kind: "discipline", kindName: "Текстовый", topic: "Предупреждения и выговоры. Закрытый канал." },
    ],
  },
  {
    name: "🔐 РУКОВОДСТВО",
    emoji: "🔐",
    access: "leadership" as const,
    channels: [
      { key: null, name: "👑・главная-администрация", kind: "leadership-chat", kindName: "Текстовый", topic: "Канал главной администрации." },
      { key: null, name: "🛡️・куратор", kind: "leadership-chat", kindName: "Текстовый", topic: "Канал куратора." },
      { key: null, name: "🎖️・руководство-отдела", kind: "leadership-chat", kindName: "Текстовый", topic: "Руководство отдела организаторов." },
      { key: null, name: "📂・управление", kind: "manage", kindName: "Текстовый", topic: "Оперативное управление отделом." },
      { key: null, name: "📑・кадровые-решения", kind: "manage", kindName: "Текстовый", topic: "Закрытые кадровые решения." },
    ],
  },
  {
    name: "🤖 BOT",
    emoji: "🤖",
    access: "public" as const,
    channels: [
      { key: "commandsChannelId", name: "🤖・команды", kind: "commands", kindName: "Текстовый", topic: "Панель команд и справка бота." },
      { key: "logsChannelId", name: "📜・логи", kind: "logs", kindName: "Текстовый", topic: "Журнал действий бота." },
      { key: "settingsChannelId", name: "⚙️・настройки", kind: "manage", kindName: "Текстовый", topic: "Настройки системы. Только руководство." },
    ],
  },
] as const;

export const VOICE_CATEGORY = {
  name: "🔊 ГОЛОСОВЫЕ",
  channels: [
    { key: "voiceGeneralId", name: "🔊・Общий", access: "public" as const },
    { key: "voiceOrganizersId", name: "🎙️・Организаторы", access: "staff" as const },
    { key: "voiceEventsId", name: "🎯・Проведение МП", access: "public" as const },
    { key: "voiceLeadershipId", name: "👑・Руководство", access: "leadership" as const },
    { key: "voicePrivateId", name: "🔒・Закрытая", access: "leadership" as const },
  ],
} as const;

/// Базовые категории МП, создаваемые при /setup (расширяемы через БД).
export const DEFAULT_EVENT_CATEGORIES = [
  { name: "Мафия", emoji: "🎭" },
  { name: "Рисовалки", emoji: "🎨" },
  { name: "Отгадай", emoji: "🧩" },
  { name: "Конкурсы", emoji: "🏆" },
  { name: "Другое", emoji: "🎲" },
] as const;

/// Достижения по умолчанию (расширяемая система — добавление через БД).
export const DEFAULT_ACHIEVEMENTS = [
  { code: "FIRST_EVENT", title: "Первое МП", description: "Провести первое мероприятие", emoji: "🥇", metric: "EVENTS_COMPLETED", threshold: 1 },
  { code: "EVENTS_10", title: "10 МП", description: "Провести 10 мероприятий", emoji: "🥈", metric: "EVENTS_COMPLETED", threshold: 10 },
  { code: "EVENTS_25", title: "25 МП", description: "Провести 25 мероприятий", emoji: "🥇", metric: "EVENTS_COMPLETED", threshold: 25 },
  { code: "EVENTS_50", title: "50 МП", description: "Провести 50 мероприятий", emoji: "🏅", metric: "EVENTS_COMPLETED", threshold: 50 },
  { code: "EVENTS_100", title: "100 МП", description: "Провести 100 мероприятий", emoji: "💎", metric: "EVENTS_COMPLETED", threshold: 100 },
  { code: "PARTICIPANTS_1000", title: "1000 участников", description: "Суммарно 1000 участников на мероприятиях", emoji: "👥", metric: "PARTICIPANTS_TOTAL", threshold: 1000 },
] as const;

/// Чек-лист подготовки МП. auto=true — пункт закрывается ботом автоматически
/// (каналы, голосовая, анонс), остальные отмечаются организатором вручную.
export const CHECKLIST_DEFS = [
  { key: "CHANNELS", label: "Каналы МП созданы", auto: true },
  { key: "VOICE", label: "Голосовой канал готов", auto: true },
  { key: "ANNOUNCE", label: "Анонс опубликован", auto: false },
  { key: "TEAM", label: "Команда (ведущий и помощники) назначена", auto: false },
  { key: "MATERIALS", label: "Вопросы и материалы подготовлены", auto: false },
  { key: "ROLES", label: "Роли и права в каналах проверены", auto: false },
] as const;

export type ChecklistKey = (typeof CHECKLIST_DEFS)[number]["key"];

export const EMBED_FOOTER = "Отдел организаторов МП Arizona";
