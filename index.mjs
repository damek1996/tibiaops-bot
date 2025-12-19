import "dotenv/config";
import { Client, GatewayIntentBits, EmbedBuilder } from "discord.js";

import { getPriceSecuraByName, formatGold } from "./provider.mjs";
import { parsePartyAnalyzerText, parseLooterAnalyzerText, computeCorrectedSettlementSecura } from "./settle.mjs";

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages]
});

// channelId -> { world, party, lootersByName: Map<string, items[]> }
const sessions = new Map();

function fmtInt(n) {
  return new Intl.NumberFormat("en-US").format(Math.trunc(n));
}

function truncate(s, max = 1024) {
  const str = String(s ?? "");
  return str.length > max ? str.slice(0, max - 3) + "..." : str;
}

async function readInputTextFromInteraction(interaction, textOptionName, fileOptionName) {
  const text = interaction.options.getString(textOptionName, false);
  const file = interaction.options.getAttachment(fileOptionName, false);

  if (text && text.trim().length) return text;

  if (file?.url) {
    const res = await fetch(file.url);
    if (!res.ok) throw new Error(`Failed to download attachment (${res.status})`);
    const body = await res.text();
    return body;
  }

  throw new Error("Provide either text OR attach a .txt file.");
}

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  // /price
  if (interaction.commandName === "price") {
    const item = interaction.options.getString("item", true);
    try {
      const p = await getPriceSecuraByName(item);
      if (!p.found) {
        return interaction.reply({ content: `No data for **${item}** (${p.reason}).`, ephemeral: true });
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

  // /settle
  if (interaction.commandName !== "settle") return;

  const sub = interaction.options.getSubcommand();

  if (sub === "start") {
    const world = interaction.options.getString("world") ?? "Secura";
    sessions.set(interaction.channelId, { world, party: null, lootersByName: new Map() });

    return interaction.reply({
      content:
        `Settlement started for **${world}**.\n` +
        `1) Use \`/settle party\` and either paste text or attach a .txt file.\n` +
        `2) Each player uses \`/settle looter\` and either pastes or attaches their analyzer.\n` +
        `3) Run \`/settle done\`.`,
      ephemeral: false
    });
  }

  if (sub === "party") {
    const sess = sessions.get(interaction.channelId);
    if (!sess) return interaction.reply({ content: "Run `/settle start` first.", ephemeral: true });

    try {
      const partyText = await readInputTextFromInteraction(interaction, "text", "file");
      const party = parsePartyAnalyzerText(partyText);

      if (!party.players.length) {
        // Debug preview so you can see what the bot actually received
        const preview = partyText.replace(/\r\n/g, "\n").slice(0, 350);
        return interaction.reply({
          content:
            `Could not parse players/supplies.\n` +
            `Received length: **${partyText.length}** chars\n` +
            `Preview:\n` +
            "```text\n" + preview + "\n```" +
            `Tip: attach a .txt file (recommended).`,
          ephemeral: true
        });
      }

      sess.party = party;

      const names = party.players.map(p => p.name).join(", ");
      return interaction.reply({
        content:
          `Party loaded. Players: **${party.players.length}**\n` +
          `Detected: ${names}\n\n` +
          `Now each player paste/attach their analyzer using:\n` +
          `\`/settle looter name:<exact name>\`\n` +
          `Paste even if: **Looted Items: None**\n` +
          `When everyone is done: \`/settle done\`.`,
        ephemeral: false
      });
    } catch (e) {
      return interaction.reply({ content: `Party load failed: ${e.message}`, ephemeral: true });
    }
  }

  if (sub === "looter") {
    const sess = sessions.get(interaction.channelId);
    if (!sess?.party) return interaction.reply({ content: "Paste/attach party first using `/settle party`.", ephemeral: true });

    const name = interaction.options.getString("name", true).trim();

    const match = sess.party.players.find(p => p.name.toLowerCase() === name.toLowerCase());
    if (!match) {
      return interaction.reply({
        content: `Name not found in party list: **${name}**. Use exact name from party analyzer.`,
        ephemeral: true
      });
    }

    try {
      const looterText = await readInputTextFromInteraction(interaction, "text", "file");
      const parsed = parseLooterAnalyzerText(looterText);

      sess.lootersByName.set(match.name, parsed.items ?? []);
      return interaction.reply({
        content: `Captured looter paste for **${match.name}**. Items parsed: **${(parsed.items ?? []).length}**.`,
        ephemeral: false
      });
    } catch (e) {
      return interaction.reply({ content: `Looter load failed: ${e.message}`, ephemeral: true });
    }
  }

  if (sub === "done") {
    const sess = sessions.get(interaction.channelId);
    if (!sess?.party) return interaction.reply({ content: "Paste/attach party first using `/settle party`.", ephemeral: true });

    if ((sess.world ?? "Secura") !== "Secura") {
      return interaction.reply({ content: "MVP supports **Secura** only right now.", ephemeral: true });
    }

    try {
      const result = await computeCorrectedSettlementSecura({
        party: sess.party,
        lootersByName: sess.lootersByName
      });

      const transfersText = result.transfers.length
        ? result.transfers.map(t => `• **${t.from}** → **${t.to}**: **${fmtInt(t.amount)} gp**`).join("\n")
        : "No transfers needed.";

      const summaryLines = result.perPlayer
        .map(p => {
          return `• **${p.name}** held ${fmtInt(p.heldLootValue || 0)} | supplies ${fmtInt(p.supplies || 0)} | fair payout ${fmtInt(p.fairPayout || 0)} | delta ${fmtInt(p.delta || 0)}`;
        })
        .join("\n");

      const embed = new EmbedBuilder()
        .setTitle("Hunt Settlement — Corrected Loot (Market BUY vs NPC BUY) + Equal Split")
        .setDescription(`World: Secura | Updated: ${result.updatedAt.toISOString()}`)
        .addFields(
          {
            name: "Totals",
            value:
              `Corrected total loot (best liquidation): **${fmtInt(result.totalHeldLoot)} gp**\n` +
              `Total supplies: **${fmtInt(result.totalSupplies)} gp**\n` +
              `Corrected net: **${fmtInt(result.correctedNet)} gp**\n` +
              `Equal share (profit): **${fmtInt(result.share)} gp**`
          },
          { name: "Per-player accounting", value: truncate(summaryLines) },
          { name: "Transfers (who sends who)", value: truncate(transfersText) }
        );

      sessions.delete(interaction.channelId);
      return interaction.reply({ embeds: [embed] });
    } catch (e) {
      return interaction.reply({ content: `Settlement failed: ${e.message}`, ephemeral: true });
    }
  }
});

client.once("ready", () => console.log(`Logged in as ${client.user.tag}`));
client.login(process.env.DISCORD_TOKEN);
