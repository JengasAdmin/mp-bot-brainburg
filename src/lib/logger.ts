type Level = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const minLevel: Level = (process.env.LOG_LEVEL as Level) || "info";

function log(level: Level, message: string, ...meta: unknown[]): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level.toUpperCase()}] ${message}`;
  const args = meta.length > 0 ? [...meta.map((m) => (m instanceof Error ? m.stack ?? m.message : m))] : [];
  if (level === "error") console.error(line, ...args);
  else if (level === "warn") console.warn(line, ...args);
  else console.log(line, ...args);
}

export const logger = {
  debug: (msg: string, ...meta: unknown[]) => log("debug", msg, ...meta),
  info: (msg: string, ...meta: unknown[]) => log("info", msg, ...meta),
  warn: (msg: string, ...meta: unknown[]) => log("warn", msg, ...meta),
  error: (msg: string, ...meta: unknown[]) => log("error", msg, ...meta),
};
