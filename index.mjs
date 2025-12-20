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

const sessions = new Map(); // channelId -> { world, party, lootersByName: Map<string, items[]> }

function fmtInt(n) {
  return new Intl.NumberFormat("en-US").format(Math.trunc(n));
}

function truncate(s, max = 1800) {
  const str = String(s ?? "");
  return str.length > max ? str.slice(0, max - 3) + "..." : str;
}

function gp(n) {
  return `${fmtInt(n)} gp`;
}

function monospaceBlock(lines) {
  return "```text\n" + lines.join("\n") + "\n```";
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

function groupTransfersByPayer(transfers) {
  const m = new Map(); // payer -> [{to, amount}]
  for (const t of transfers) {
    if (!m.has(t.from)) m.set(t.from, []);
    m.get(t.from).push({ to: t.to, amount: t.amount });
  }
  for (const [k, arr] of m.entries()) {
    arr.sort((a, b) => b.amount - a.amount);
    m.set(k, arr);
  }
  return m;
}

function topRows(rows, max = 8) {
  return (rows ?? []).slice(0, max);
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

      const embed = new EmbedBuilder()
        .setTitle(`💱 Price — ${item} (Secura)`)
        .setDescription(`Snapshot: ${p.updatedAt.toISOString()}`)
        .addFields(
          { name: "Market BUY offer", value: p.buy != null ? `**${formatGold(p.buy)} gp**` : "**n/a**", inline: true },
          { name: "Market SELL offer", value: p.sell != null ? `**${formatGold(p.sell)} gp**` : "**n/a**", inline: true }
        );

      return interaction.reply({ embeds: [embed], ephemeral: true });
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

    const embed = new EmbedBuilder()
      .setTitle("🧾 Settlement started")
      .setDescription(
        `World: **${world}**\n\n` +
        `1) Use **/settle party** (paste or attach .txt)\n` +
        `2) Each player uses **/settle looter** (paste or attach .txt)\n` +
        `3) Run **/settle done**`
      );

    return interaction.reply({ embeds: [embed], ephemeral: false });
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
      const embed = new EmbedBuilder()
        .setTitle("👥 Party loaded")
        .setDescription(`Players (**${party.players.length}**):\n${names}`)
        .addFields({
          name: "Next",
          value:
            `Each player paste/attach their analyzer (even if **Looted Items: None**):\n` +
            `Use: **/settle looter name:<exact name>**`
        });

      return interaction.reply({ embeds: [embed], ephemeral: false });
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

      const embed = new EmbedBuilder()
        .setTitle("📦 Looter captured")
        .setDescription(`Player: **${match.name}**`)
        .addFields({ name: "Items parsed", value: `**${(parsed.items ?? []).length}**`, inline: true });

      return interaction.reply({ embeds: [embed], ephemeral: false });
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

      const nPlayers = result.perPlayer.length;
      const remainder = result.correctedNet - (result.share * nPlayers);

      // Summary embed
      const summary = new EmbedBuilder()
        .setTitle("✅ Settlement complete — Corrected loot + Equal split")
        .setDescription(`World: **Secura** • Snapshot: ${result.updatedAt.toISOString()}`)
        .addFields(
          {
            name: "💰 Totals",
            value:
              `Players: **${nPlayers}**\n` +
              `Corrected loot: **${gp(result.totalHeldLoot)}**\n` +
              `Supplies: **${gp(result.totalSupplies)}**\n` +
              `Net profit: **${gp(result.correctedNet)}**\n` +
              `Profit per player: **${gp(result.share)}**\n` +
              `Remainder: **${gp(remainder)}**`
          }
        );

      const accountingLines = result.perPlayer
        .map(p => {
          const sign = p.delta >= 0 ? "+" : "-";
          return `${p.name.padEnd(16)} held ${fmtInt(p.heldLootValue).padStart(10)} | sup ${fmtInt(p.supplies).padStart(9)} | payout ${fmtInt(p.fairPayout).padStart(10)} | delta ${sign}${fmtInt(Math.abs(p.delta)).padStart(10)}`;
        });

      summary.addFields({
        name: "🧮 Per-player accounting (held vs fair payout)",
        value: monospaceBlock(truncate(accountingLines.join("\n"), 900).split("\n"))
      });

      await interaction.reply({ embeds: [summary] });

      // Transfers embed
      const transfersMap = groupTransfersByPayer(result.transfers);
      const transferLines = [];

      if (result.transfers.length === 0) {
        transferLines.push("No transfers needed.");
      } else {
        for (const [payer, arr] of transfersMap.entries()) {
          transferLines.push(`${payer}:`);
          for (const x of arr) {
            transferLines.push(`  -> ${x.to}: ${fmtInt(x.amount)} gp`);
          }
          transferLines.push("");
        }
      }

      const transfersEmbed = new EmbedBuilder()
        .setTitle("🏦 Transfers (who sends who)")
        .setDescription(monospaceBlock(truncate(transferLines.join("\n"), 1800).split("\n")));

      await interaction.followUp({ embeds: [transfersEmbed] });

      // Sell embeds per player
      for (const p of result.perPlayer) {
        const ins = result.sellInstructionsByPlayer.get(p.name) || { sellBuy: [], sellNpc: [], unmatched: [] };

        const buyTop = topRows(ins.sellBuy, 10);
        const npcTop = topRows(ins.sellNpc, 10);

        const buyLines = buyTop.length
          ? buyTop.map(x => `${String(x.qty).padStart(4)}x ${x.name.padEnd(28)} | BUY ${fmtInt(x.marketBuy).padStart(8)} | NPC ${fmtInt(x.npcBuy).padStart(8)}`)
          : ["(none)"];

        const npcLines = npcTop.length
          ? npcTop.map(x => `${String(x.qty).padStart(4)}x ${x.name.padEnd(28)} | NPC ${fmtInt(x.npcBuy).padStart(8)} | BUY ${fmtInt(x.marketBuy).padStart(8)}`)
          : ["(none)"];

        const unmatchedLines = (ins.unmatched && ins.unmatched.length)
          ? ins.unmatched.slice(0, 10).map(x => `${x.qty}x ${x.name}`)
          : [];

        const embed = new EmbedBuilder()
          .setTitle(`🧺 Sell instructions — ${p.name}`)
          .setDescription("Rule: value per item = max(Market BUY, NPC BUY).")
          .addFields(
            { name: "🟦 Sell on Market (BUY offer) — top items", value: monospaceBlock(buyLines), inline: false },
            { name: "🟨 Sell to NPC — top items", value: monospaceBlock(npcLines), inline: false }
          );

        if (unmatchedLines.length) {
          embed.addFields({
            name: "⚠️ Unmatched items (name not found in metadata)",
            value: monospaceBlock(unmatchedLines),
            inline: false
          });
        }

        await interaction.followUp({ embeds: [embed] });
      }

      sessions.delete(interaction.channelId);
    } catch (e) {
      return interaction.reply({ content: `Settlement failed: ${e.message}`, ephemeral: true });
    }
  }
});

client.once("ready", () => console.log(`Logged in as ${client.user.tag}`));
client.login(process.env.DISCORD_TOKEN);
