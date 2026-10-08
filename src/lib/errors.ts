/// Ошибка, адресованная пользователю: её сообщение показывается в интерфейсе
/// как есть. Остальные ошибки логируются, пользователю — общий текст.
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserError";
  }
}
