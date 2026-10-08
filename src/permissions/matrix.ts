/// Матрица прав: должность (тир) → разрешённые действия.
/// Проверка прав выполняется на backend-уровне для КАЖДОЙ команды и кнопки.
/// Скрытие slash-команд — только UX, не защита.

export type Position =
  | "ADMIN"     // Главная Администрация
  | "CURATOR"   // Куратор
  | "HEAD"      // Главный Организатор МП
  | "SENIOR"    // Старший Организатор МП
  | "ORGANIZER" // Организатор МП
  | "ASSISTANT" // Помощник Организаторов
  | "GUEST";

export const POSITION_RANK: Record<Position, number> = {
  ADMIN: 6,
  CURATOR: 5,
  HEAD: 4,
  SENIOR: 3,
  ORGANIZER: 2,
  ASSISTANT: 1,
  GUEST: 0,
};

export const POSITION_RU: Record<Position, string> = {
  ADMIN: "Главная Администрация",
  CURATOR: "Куратор",
  HEAD: "Главный Организатор МП",
  SENIOR: "Старший Организатор МП",
  ORGANIZER: "Организатор МП",
  ASSISTANT: "Помощник Организаторов",
  GUEST: "Не состоит в отделе",
};

export type Permission =
  | "SETUP"             // первичная настройка сервера
  | "REVIEW"            // проверка заявок: одобрение/отклонение/доработка
  | "ASSIGN"            // назначение организатора
  | "ARCHIVE"           // архивирование после проверки отчёта
  | "EDIT_ANY_EVENT"    // редактирование чужих мероприятий
  | "CREATE_APPLICATION"// подача заявок на МП
  | "STATS_VIEW"        // просмотр расширенной статистики
  | "PROMOTE"           // кадровые решения: повышение/понижение
  | "WARN"              // предупреждения и выговоры
  | "TEST_MANAGE"       // управление тестами и вопросами
  | "INTERNSHIP"        // управление стажировкой
  | "VIEW_LOGS";        // доступ к журналу аудита

const REQUIRED: Record<Permission, Position[]> = {
  SETUP: ["ADMIN"],
  REVIEW: ["ADMIN", "CURATOR", "HEAD", "SENIOR"],
  ASSIGN: ["ADMIN", "CURATOR", "HEAD", "SENIOR"],
  ARCHIVE: ["ADMIN", "CURATOR", "HEAD", "SENIOR"],
  EDIT_ANY_EVENT: ["ADMIN", "CURATOR", "HEAD", "SENIOR"],
  CREATE_APPLICATION: ["ADMIN", "CURATOR", "HEAD", "SENIOR", "ORGANIZER", "ASSISTANT"],
  STATS_VIEW: ["ADMIN", "CURATOR", "HEAD", "SENIOR", "ORGANIZER", "ASSISTANT"],
  PROMOTE: ["ADMIN", "CURATOR", "HEAD"],
  WARN: ["ADMIN", "CURATOR", "HEAD", "SENIOR"],
  TEST_MANAGE: ["ADMIN", "CURATOR", "HEAD", "SENIOR"],
  INTERNSHIP: ["ADMIN", "CURATOR", "HEAD", "SENIOR"],
  VIEW_LOGS: ["ADMIN", "CURATOR", "HEAD"],
};

export function hasPermission(position: Position, permission: Permission): boolean {
  return REQUIRED[permission].includes(position);
}

export function isStaff(position: Position): boolean {
  return POSITION_RANK[position] >= POSITION_RANK.ASSISTANT;
}

export function hasAtLeast(position: Position, minimum: Position): boolean {
  return POSITION_RANK[position] >= POSITION_RANK[minimum];
}

/// Тир, которого достаточно для выполнения действия (для текстов ошибок).
export function describePermission(permission: Permission): string {
  const roles = REQUIRED[permission].map((p) => POSITION_RU[p]);
  return `Доступно: ${roles.join(", ")}.`;
}

/// Централизованный сервис прав — единственная точка принятия решений
/// «кто может». Вызывается из команд, кнопок, модалок и селектов.
export const PermissionService = {
  canSetup: (p: Position) => hasPermission(p, "SETUP"),
  canCreateEvent: (p: Position) => hasPermission(p, "CREATE_APPLICATION"),
  canApproveEvent: (p: Position) => hasPermission(p, "REVIEW"),
  canAssignOrganizer: (p: Position) => hasPermission(p, "ASSIGN"),
  canEditAnyEvent: (p: Position) => hasPermission(p, "EDIT_ANY_EVENT"),
  canArchiveEvent: (p: Position) => hasPermission(p, "ARCHIVE"),
  canManagePersonnel: (p: Position) => hasPermission(p, "PROMOTE"),
  canViewDiscipline: (p: Position) => hasPermission(p, "WARN"),
  canManageTests: (p: Position) => hasPermission(p, "TEST_MANAGE"),
  canManageInternship: (p: Position) => hasPermission(p, "INTERNSHIP"),
  canViewStats: (p: Position) => hasPermission(p, "STATS_VIEW"),
  canViewLogs: (p: Position) => hasPermission(p, "VIEW_LOGS"),
} as const;
