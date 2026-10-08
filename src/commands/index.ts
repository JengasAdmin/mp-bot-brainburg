import type { AutocompleteInteraction, ChatInputCommandInteraction, Client } from "discord.js";
import * as setup from "./setup";
import * as createEvent from "./createEvent";
import * as events from "./events";
import * as myEvents from "./myEvents";
import * as event from "./event";
import * as editEvent from "./editEvent";
import * as cancelEvent from "./cancelEvent";
import * as approve from "./approve";
import * as reject from "./reject";
import * as requestRevision from "./requestRevision";
import * as assign from "./assign";
import * as startEvent from "./startEvent";
import * as finishEvent from "./finishEvent";
import * as report from "./report";
import * as archive from "./archive";
import * as stats from "./stats";
import * as rating from "./rating";
import * as template from "./template";
import * as calendar from "./calendar";
import * as exportCmd from "./export";
import * as profile from "./profile";
import * as test from "./test";
import * as promote from "./promote";
import * as warning from "./warning";
import * as reprimand from "./reprimand";
import * as discipline from "./discipline";
import * as internship from "./internship";
import * as logs from "./logs";
import * as rotation from "./rotation";
import * as material from "./material";

export interface SlashCommandModule {
  data: {
    name: string;
    description: string;
    toJSON: () => unknown;
  };
  execute: (interaction: ChatInputCommandInteraction, client: Client) => Promise<void>;
  autocomplete?: (interaction: AutocompleteInteraction) => Promise<void>;
}

/// Реестр slash-команд. Регистрация выполняется в index.ts с проверкой
/// расхождений — при каждом запуске команды не перерегистрируются без нужды.
export const commands: SlashCommandModule[] = [
  setup,
  createEvent,
  events,
  myEvents,
  event,
  editEvent,
  cancelEvent,
  approve,
  reject,
  requestRevision,
  assign,
  startEvent,
  finishEvent,
  report,
  archive,
  stats,
  rating,
  template,
  calendar,
  exportCmd,
  profile,
  test,
  promote,
  warning,
  reprimand,
  discipline,
  internship,
  logs,
  rotation,
  material,
];

export function getCommand(name: string): SlashCommandModule | undefined {
  return commands.find((c) => c.data.name === name);
}
