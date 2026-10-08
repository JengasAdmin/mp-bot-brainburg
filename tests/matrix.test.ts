import { describe, expect, it } from "vitest";
import {
  PermissionService,
  POSITION_RANK,
  POSITION_RU,
  describePermission,
  hasAtLeast,
  hasPermission,
  isStaff,
  type Permission,
  type Position,
} from "../src/permissions/matrix";

const ALL_POSITIONS: Position[] = ["ADMIN", "CURATOR", "HEAD", "SENIOR", "ORGANIZER", "ASSISTANT", "GUEST"];

describe("иерархия должностей", () => {
  it("ранги строго убывают от ADMIN к GUEST", () => {
    expect(POSITION_RANK.ADMIN).toBeGreaterThan(POSITION_RANK.CURATOR);
    expect(POSITION_RANK.CURATOR).toBeGreaterThan(POSITION_RANK.HEAD);
    expect(POSITION_RANK.HEAD).toBeGreaterThan(POSITION_RANK.SENIOR);
    expect(POSITION_RANK.SENIOR).toBeGreaterThan(POSITION_RANK.ORGANIZER);
    expect(POSITION_RANK.ORGANIZER).toBeGreaterThan(POSITION_RANK.ASSISTANT);
    expect(POSITION_RANK.ASSISTANT).toBeGreaterThan(POSITION_RANK.GUEST);
  });

  it("каждая должность имеет русское название", () => {
    for (const p of ALL_POSITIONS) expect(POSITION_RU[p]).toBeTruthy();
  });

  it("hasAtLeast сравнивает по рангу", () => {
    expect(hasAtLeast("HEAD", "ORGANIZER")).toBe(true);
    expect(hasAtLeast("ORGANIZER", "HEAD")).toBe(false);
    expect(hasAtLeast("GUEST", "GUEST")).toBe(true);
  });

  it("сотрудник — это ASSISTANT и выше", () => {
    expect(isStaff("ASSISTANT")).toBe(true);
    expect(isStaff("ORGANIZER")).toBe(true);
    expect(isStaff("GUEST")).toBe(false);
  });
});

describe("матрица прав", () => {
  it("GUEST не имеет ни одного права", () => {
    const permissions = Object.keys(PermissionService).length;
    expect(permissions).toBeGreaterThan(0);
    for (const key of Object.keys(PermissionService)) {
      const check = PermissionService[key as keyof typeof PermissionService];
      expect(check("GUEST")).toBe(false);
    }
  });

  it("ADMIN имеет все права", () => {
    for (const key of Object.keys(PermissionService)) {
      const check = PermissionService[key as keyof typeof PermissionService];
      expect(check("ADMIN")).toBe(true);
    }
  });

  it("настройка сервера — только ADMIN", () => {
    for (const p of ALL_POSITIONS) {
      expect(hasPermission(p, "SETUP")).toBe(p === "ADMIN");
    }
  });

  it("рассмотрение заявок доступно с SENIOR и выше", () => {
    for (const p of ALL_POSITIONS) {
      expect(hasPermission(p, "REVIEW")).toBe(["ADMIN", "CURATOR", "HEAD", "SENIOR"].includes(p));
    }
  });

  it("подача заявок доступна сотрудникам отдела (ASSISTANT+)", () => {
    for (const p of ALL_POSITIONS) {
      expect(hasPermission(p, "CREATE_APPLICATION")).toBe(p !== "GUEST");
    }
  });

  it("кадровые решения — только HEAD и выше", () => {
    expect(hasPermission("SENIOR", "PROMOTE")).toBe(false);
    expect(hasPermission("HEAD", "PROMOTE")).toBe(true);
    expect(hasPermission("CURATOR", "PROMOTE")).toBe(true);
  });

  it("журнал аудита закрыт для ORGANIZER и ниже", () => {
    expect(hasPermission("ORGANIZER", "VIEW_LOGS")).toBe(false);
    expect(hasPermission("SENIOR", "VIEW_LOGS")).toBe(false);
    expect(hasPermission("HEAD", "VIEW_LOGS")).toBe(true);
  });

  it("каждое право достигаемо хотя бы одной должностью (нет «мертвых» прав)", () => {
    const all: Permission[] = [
      "SETUP", "REVIEW", "ASSIGN", "ARCHIVE", "EDIT_ANY_EVENT", "CREATE_APPLICATION",
      "STATS_VIEW", "PROMOTE", "WARN", "TEST_MANAGE", "INTERNSHIP", "VIEW_LOGS",
    ];
    for (const perm of all) {
      expect(ALL_POSITIONS.some((p) => hasPermission(p, perm))).toBe(true);
    }
  });
});

describe("описание прав и PermissionService", () => {
  it("describePermission перечисляет должности по-русски", () => {
    const text = describePermission("SETUP");
    expect(text).toContain("Главная Администрация");
    expect(text).not.toContain("Куратор");
  });

  it("методы PermissionService делегируют в hasPermission", () => {
    expect(PermissionService.canSetup("ADMIN")).toBe(hasPermission("ADMIN", "SETUP"));
    expect(PermissionService.canApproveEvent("SENIOR")).toBe(hasPermission("SENIOR", "REVIEW"));
    expect(PermissionService.canViewLogs("ORGANIZER")).toBe(false);
    expect(PermissionService.canManageTests("HEAD")).toBe(true);
  });
});
