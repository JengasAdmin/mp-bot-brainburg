import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Client,
} from "discord.js";
import { commandContext, ephemeral } from "../interactions/shared";
import { UserError } from "../lib/errors";
import { withFooter } from "../lib/embeds";
import { hasAtLeast } from "../permissions/matrix";
import { buildEventComponents, buildEventEmbed, buildReviewComponents, buildReviewEmbed } from "../services/events";
import { STATUS } from "../constants";
import { autocompleteEvents, eventFromOption } from "./common";

export const data = new SlashCommandBuilder()
  .setName("event")
  .setDescription("Карточка мероприятия по коду (MP-0001)")
  .addStringOption((o) =>
    o.setName("event").setDescription("Код мероприятия").setRequired(true).setAutocomplete(true)
  );

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  await autocompleteEvents(interaction);
}

export async function execute(interaction: ChatInputCommandInteraction, _client: Client): Promise<void> {
  const ctx = await commandContext(interaction);
  const event = await eventFromOption(interaction);

  const isStaff = hasAtLeast(ctx.position, "ASSISTANT");
  const isMine = ctx.userId === event.authorId || ctx.userId === event.organizerId;
  if (!isStaff && !isMine) {
    throw new UserError("Посмотреть карточку может автор, организатор или сотрудник отдела.");
  }

  const reviewable = [STATUS.PENDING, STATUS.REVISION].includes(event.status as never);
  const embed = reviewable ? buildReviewEmbed(event) : buildEventEmbed(event);
  const components = reviewable
    ? buildReviewComponents(event)
    : buildEventComponents(event);

  if (isStaff || isMine) {
    components.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`ev:history:${event.id}`)
          .setLabel("История статусов")
          .setEmoji("🕒")
          .setStyle(ButtonStyle.Secondary)
      )
    );
  }

  if (components.length === 0) {
    await ephemeral(interaction, { embeds: [withFooter(embed)] });
    return;
  }

  await interaction.reply({
    embeds: [withFooter(embed)],
    components,
    flags: MessageFlags.Ephemeral,
  });
}
