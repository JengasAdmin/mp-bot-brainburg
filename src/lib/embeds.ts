import { EmbedBuilder } from "discord.js";
import { COLORS, EMBED_FOOTER, STATUS_RU } from "../constants";

export { COLORS };

export function baseEmbed(title?: string): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(COLORS.BRAND).setTimestamp();
  if (title) embed.setTitle(title);
  return embed;
}

export function infoEmbed(title: string, description?: string): EmbedBuilder {
  const embed = baseEmbed(title).setColor(COLORS.INFO);
  if (description) embed.setDescription(description);
  return embed;
}

export function successEmbed(title: string, description?: string): EmbedBuilder {
  const embed = baseEmbed(title).setColor(COLORS.SUCCESS);
  if (description) embed.setDescription(description);
  return embed;
}

export function errorEmbed(title: string, description?: string): EmbedBuilder {
  const embed = baseEmbed(title).setColor(COLORS.DANGER);
  if (description) embed.setDescription(description);
  return embed;
}

export function warnEmbed(title: string, description?: string): EmbedBuilder {
  const embed = baseEmbed(title).setColor(COLORS.WARNING);
  if (description) embed.setDescription(description);
  return embed;
}

export function statusEmbed(title: string, description: string | undefined, status: string): EmbedBuilder {
  const meta = STATUS_RU[status] ?? { color: COLORS.TEXT_MUTED, label: status, emoji: "❓" };
  const embed = baseEmbed(title).setColor(meta.color);
  if (description) embed.setDescription(description);
  return embed;
}

export function withFooter(embed: EmbedBuilder): EmbedBuilder {
  return embed.setFooter({ text: EMBED_FOOTER });
}
