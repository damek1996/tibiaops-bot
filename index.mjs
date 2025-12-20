import "dotenv/config";
import { Client, GatewayIntentBits, EmbedBuilder } from "discord.js";

import { getPriceSecuraByName, formatGold } from "./provider.mjs";
import {
  parsePartyAnalyzerText,
  parseLooterAnalyzerText,
  computeCorrectedSettlementSecura
} from "./settle.mjs";

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages]
});

// channelId -> { world, party, lootersByName: Map<string, items[]> }
const sessions = new Map();

function fmtInt(n) {
  return new Intl.NumberFormat("en-US").format(Math.trunc(n));
}

function truncate(s, max = 1800) {
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
    return await res.text();
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
        `1) /settle party (paste or attach .txt)\n` +
        `2) Each player: /settle looter name:<exact party name> (paste or attach .txt)\n` +
        `3) /settle done`,
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
        const preview = partyText.replace(/\r\n/g, "\n").slice(0, 450);
        return interaction.reply({
          content:
            `Could not parse party players (Supplies required).\n` +
            `Received length: **${partyText.length}** chars\n` +
            `Preview:\n` +
            "```text\n" + preview + "\n```\n" +
            `Tip: attach the party analyzer as a .txt file.`,
          ephemeral: true
        });
      }

      sess.party = party;

      const names = party.players.map(p => p.name).join(", ");
      return interaction.reply({
        content:
          `Party loaded. Players: **${party.players.length}**\n` +
          `Detected: ${names}\n\n` +
          `Now each player paste/attach their analyzer (even if Looted Items: None):\n` +
          `Use: /settle looter name:<exact name>`,
        ephemeral: false
      });
    } catch (e) {
      return interaction.reply({ content: `Party load failed: ${e.message}`, ephemeral: true });
    }
  }

  if (sub === "looter") {
    const sess = sessions.get(interaction.channelId);
    if (!sess?.party) {
      return interaction.reply({ content: "Paste/attach party first using `/settle party`.", ephemeral: true });
    }

    const nameInput = interaction.options.getString("name", true).trim();
    const match = sess.party.players.find(p => p.name.toLowerCase() === nameInput.toLowerCase());

    if (!match) {
      return interaction.reply({
        content: `Name not found in party list: **${nameInput}**. Use exact name from party analyzer.`,
        ephemeral: true
      });
    }

    try {
      const looterText = await readInputTextFromInteraction(interaction, "text", "file");
      const parsed = parseLooterAnalyzerText(looterText);

      sess.lootersByName.set(match.name, parsed.items ?? []);
      return interaction.reply({
        content: `Captured looter analyzer for **${match.name}**. Items parsed: **${(parsed.items ?? []).length}**.`,
        ephemeral: false
      });
    } catch (e) {
      return interaction.reply({ content: `Looter load failed: ${e.message}`, ephemeral: true });
    }
  }

  if (sub === "done") {
    const sess = sessions.get(interaction.channelId);
    if (!sess?.party) return interaction.reply({ content: "Paste/attach party first using `/settle party`.", ephemeral: true });
    if ((sess.world ?? "Secura") !== "Secura") return interaction.reply({ content: "MVP supports **Secura** only right now.", ephemeral: true });

    const missing = sess.party.players.filter(p => !sess.lootersByName.has(p.name)).map(p => p.name);
    if (missing.length) {
      return interaction.reply({
        content: `Missing looter analyzer for: ${missing.join(", ")} (paste even if "Looted Items: None").`,
        ephemeral: true
      });
    }

    try {
      const result = await computeCorrectedSettlementSecura({
        party: sess.party,
        lootersByName: sess.lootersByName
      });

      const transfersText = result.transfers.length
        ? result.transfers.map(t => `• **${t.from}** → **${t.to}**: **${fmtInt(t.amount)} gp**`).join("\n")
        : "No transfers needed.";

      const perPlayerLines = result.perPlayer
        .map(p =>
          `• **${p.name}** held ${fmtInt(p.heldLootValue)} | supplies ${fmtInt(p.supplies)} | fair payout ${fmtInt(p.fairPayout)} | delta ${fmtInt(p.delta)}`
        )
        .join("\n");

      const embed = new EmbedBuilder()
        .setTitle("Hunt Settlement — Corrected Loot (Market BUY vs NPC BUY) + Equal Split")
        .setDescription(`World: Secura | Market snapshot: ${result.updatedAt.toISOString()}`)
        .addFields(
          {
            name: "Totals",
            value:
              `Corrected total loot (best liquidation): **${fmtInt(result.totalHeldLoot)} gp**\n` +
              `Total supplies: **${fmtInt(result.totalSupplies)} gp**\n` +
              `Corrected net: **${fmtInt(result.correctedNet)} gp**\n` +
              `Equal share (profit): **${fmtInt(result.share)} gp**`
          },
          { name: "Per-player accounting", value: truncate(perPlayerLines, 1024) },
          { name: "Transfers (who sends who)", value: truncate(transfersText, 1024) }
        );

      await interaction.reply({ embeds: [embed] });

      // Follow-ups: sell instructions per player
      for (const p of result.perPlayer) {
        const ins = result.sellInstructionsByPlayer.get(p.name) || { sellBuy: [], sellNpc: [], unmatched: [] };

        const buyList = ins.sellBuy.length
          ? ins.sellBuy.slice(0, 30).map(x => `- ${x.qty}x ${x.name} (BUY ${fmtInt(x.marketBuy)} | NPC ${fmtInt(x.npcBuy)})`).join("\n")
          : "- None";

        const npcList = ins.sellNpc.length
          ? ins.sellNpc.slice(0, 30).map(x => `- ${x.qty}x ${x.name} (NPC ${fmtInt(x.npcBuy)} | BUY ${fmtInt(x.marketBuy)})`).join("\n")
          : "- None";

        const msg =
          `**Sell instructions — ${p.name}**\n` +
          `**Sell on Market (BUY offer):**\n` +
          "```text\n" + truncate(buyList, 1800) + "\n```\n" +
          `**Sell to NPC:**\n` +
          "```text\n" + truncate(npcList, 1800) + "\n```";

        await interaction.followUp({ content: msg });
      }

      sessions.delete(interaction.channelId);
    } catch (e) {
      return interaction.reply({ content: `Settlement failed: ${e.message}`, ephemeral: true });
    }
  }
});

client.once("ready", () => console.log(`Logged in as ${client.user.tag}`));
client.login(process.env.DISCORD_TOKEN);
