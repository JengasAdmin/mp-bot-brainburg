/// Черновики заявок/отчётов в памяти (вторая ступень модалок).
/// Черновик — временные данные: после перезапуска пользователь просто заполняет
/// форму заново; в БД ничего не теряется.

const drafts = new Map<string, { data: Record<string, unknown>; expires: number }>();
const TTL_MS = 15 * 60_000;

export function setDraft(key: string, data: Record<string, unknown>): void {
  drafts.set(key, { data, expires: Date.now() + TTL_MS });
}

export function takeDraft(key: string): Record<string, unknown> | null {
  const entry = drafts.get(key);
  if (!entry) return null;
  drafts.delete(key);
  if (entry.expires < Date.now()) return null;
  return entry.data;
}

export function cleanupDrafts(): void {
  const now = Date.now();
  for (const [key, entry] of drafts) {
    if (entry.expires < now) drafts.delete(key);
  }
}
