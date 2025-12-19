import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder
} from "discord.js";

import { getPriceSecuraByName, formatGold } from "./provider.mjs";
import { parseAnalyzerText, computeSettlementSecura } from "./settle.mjs";

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages]
});

// In-memory settlement sessions: channelId -> { world, roles[], idx, players[] }
const settleSessions = new Map();

function fmtInt(n) {
  return new Intl.NumberFormat("en-US").format(Math.trunc(n));
}

client.on("interactionCreate", async interaction => {
  // ---------- Buttons (settlement flow) ----------
  if (interaction.isButton()) {
    const sess = settleSessions.get(interaction.channelId);
    if (!sess) {
      return interaction.reply({ content: "No active settlement session in this channel.", ephemeral: true });
    }

    if (interaction.customId === "settle_cancel") {
      settleSessions.delete(interaction.channelId);
      return interaction.reply({ content: "Settlement cancelled.", ephemeral: true });
    }

    if (interaction.customId === "settle_add") {
      sess.idx += 1;
      const nextRole = sess.roles[sess.idx] ?? `PLAYER${sess.idx + 1}`;
      return interaction.reply({
        content: `OK. **${nextRole}**: use \`/settle paste\` and paste your analyzer now.`,
        ephemeral: false
      });
    }

    if (interaction.customId === "settle_calc") {
      try {
        const world = sess.world ?? "Secura";
        if (world !== "Secura") {
          return interaction.reply({ content: "MVP supports world **Secura** only right now.", ephemeral: true });
        }

        const result = await computeSettlementSecura(sess.players);

        const transfersText = result.transfers.length
          ? result.transfers
              .map(t => `• **${t.from}** → **${t.to}**: **${fmtInt(t.amount)} gp**`)
              .join("\n")
          : "No transfers needed.";

        const buyText = result.sellBuy.length
          ? result.sellBuy
              .slice(0, 25)
              .map(x => `• ${x.qty}x ${x.name} (BUY ${fmtInt(x.marketBuy ?? 0)} | NPC ${fmtInt(x.npcSell)})`)
              .join("\n")
          : "None.";

        const npcText = result.sellNpc.length
          ? result.sellNpc
              .slice(0, 25)
              .map(x => `• ${x.qty}x ${x.name} (NPC ${fmtInt(x.npcSell)} | BUY ${fmtInt(x.marketBuy ?? 0)})`)
              .join("\n")
          : "None.";

        const embed = new EmbedBuilder()
          .setTitle("Hunt Settlement — Secura (BUY vs NPC)")
          .setDescription(`Updated: ${result.updatedAt.toISOString()}`)
          .addFields(
            {
              name: "Totals",
              value:
                `Loot (best liquidation): **${fmtInt(result.totalLootValue)} gp**\n` +
                `Supplies: **${fmtInt(result.totalSupplies)} gp**\n` +
                `Net: **${fmtInt(result.totalNet)} gp**\n` +
                `Share each (${sess.players.length}): **${fmtInt(result.share)} gp**`
            },
            { name: "Transfers", value: transfersText.slice(0, 1024) },
            { name: `Loot holder: ${result.lootHolder} — SELL TO MARKET BUY`, value: buyText.slice(0, 1024) },
            { name: `Loot holder: ${result.lootHolder} — SELL TO NPC`, value: npcText.slice(0, 1024) }
          );

        settleSessions.delete(interaction.channelId);
        return interaction.reply({ embeds: [embed] });
      } catch (e) {
        return interaction.reply({ content: `Settlement failed: ${e.message}`, ephemeral: true });
      }
    }

    return;
  }

  // ---------- Slash commands ----------
  if (!interaction.isChatInputCommand()) return;

  // /price
  if (interaction.commandName === "price") {
    const item = interaction.options.getString("item", true);

    try {
      const p = await getPriceSecuraByName(item);

      if (!p.found) {
        return interaction.reply({
          content: `No data for **${item}** (${p.reason}).`,
          ephemeral: true
        });
      }

      return interaction.reply({
        content:
          `**Secura — ${item}**\n` +
          `BUY offer: **${p.buy != null ? formatGold(p.buy) : "n/a"} gp**\n` +
          `SELL offer: **${p.sell != null ? formatGold(p.sell) : "n/a"} gp**\n` +
          `Updated: ${p.updatedAt.toISOString()}`,
        ephemeral: true
      });
    } catch (e) {
      return interaction.reply({ content: `Price check failed: ${e.message}`, ephemeral: true });
    }
  }

  // /settle start | /settle paste
  if (interaction.commandName === "settle") {
    const sub = interaction.options.getSubcommand();

    if (sub === "start") {
      const rolesRaw = interaction.options.getString("roles") ?? "KNIGHT,RP,MS,ED";
      const world = interaction.options.getString("world") ?? "Secura";
      const roles = rolesRaw
        .split(",")
        .map(s => s.trim())
        .filter(Boolean);

      if (!roles.length) roles.push("PLAYER1");

      settleSessions.set(interaction.channelId, {
        world,
        roles,
        idx: 0,
        players: []
      });

      return interaction.reply({
        content:
          `Settlement started for **${world}**.\n` +
          `**${roles[0]}**: use \`/settle paste\` and paste your analyzer text (include **Looted Items**).`,
        ephemeral: false
      });
    }

    if (sub === "paste") {
      const sess = settleSessions.get(interaction.channelId);
      if (!sess) {
        return interaction.reply({ content: "No active settlement. Run `/settle start` first.", ephemeral: true });
      }

      const role = sess.roles[sess.idx] ?? `PLAYER${sess.idx + 1}`;
      const text = interaction.options.getString("text", true);

      const parsed = parseAnalyzerText(text);

      // minimal validation
      if (parsed.supplies == null) {
        return interaction.reply({
          content: "Could not parse `Supplies:`. Paste the full analyzer output.",
          ephemeral: true
        });
      }

      sess.players.push({
        role,
        discordName: interaction.user.username,
        supplies: parsed.supplies ?? 0,
        loot: parsed.loot ?? null,
        balance: parsed.balance ?? null,
        items: parsed.items ?? []
      });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("settle_add").setLabel("Add another player").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("settle_calc").setLabel("No, calculate now").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("settle_cancel").setLabel("Cancel").setStyle(ButtonStyle.Danger)
      );

      return interaction.reply({
        content: `Captured **${role}** from **${interaction.user.username}**. Items parsed: **${parsed.items.length}**.\nDo we need an additional player?`,
        components: [row]
      });
    }
  }
});

client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.login(process.env.DISCORD_TOKEN);
