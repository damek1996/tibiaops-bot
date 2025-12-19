import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder
} from "discord.js";

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

function truncate(s, max = 1024) {
  const str = String(s ?? "");
  return str.length > max ? str.slice(0, max - 3) + "..." : str;
}

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  // ---------------- /price ----------------
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
      return interaction.reply({
        content: `Price check failed: ${e.message}`,
        ephemeral: true
      });
    }
  }

  // ---------------- /settle ----------------
  if (interaction.commandName !== "settle") return;

  const sub = interaction.options.getSubcommand();

  // /settle start
  if (sub === "start") {
    const world = interaction.options.getString("world") ?? "Secura";

    sessions.set(interaction.channelId, {
      world,
      party: null,
      lootersByName: new Map()
    });

    return interaction.reply({
      content:
        `Settlement started for **${world}**.\n` +
        `1) Paste Party Hunt Analyzer with \`/settle party\`\n` +
        `2) Each player pastes their analyzer (even if Looted Items: None) using \`/settle looter name:<exact party name>\`\n` +
        `3) Run \`/settle done\``,
      ephemeral: false
    });
  }

  // /settle party
  if (sub === "party") {
    const sess = sessions.get(interaction.channelId);
    if (!sess) {
      return interaction.reply({
        content: "Run `/settle start` first.",
        ephemeral: true
      });
    }

    const text = interaction.options.getString("text", true);
    const party = parsePartyAnalyzerText(text);

    if (!party.players.length) {
      return interaction.reply({
        content:
          "Could not parse players/supplies from Party Hunt Analyzer. Paste the full party block.",
        ephemeral: true
      });
    }

    sess.party = party;

    const names = party.players.map(p => p.name).join(", ");
    return interaction.reply({
      content:
        `Party loaded. Players: **${party.players.length}**\n` +
        `Detected: ${names}\n\n` +
        `Now each player paste their analyzer with items using:\n` +
        `\`/settle looter name:<exact name>\`\n` +
        `Paste even if: **Looted Items: None**\n` +
        `When everyone pasted, run \`/settle done\`.`,
      ephemeral: false
    });
  }

  // /settle looter
  if (sub === "looter") {
    const sess = sessions.get(interaction.channelId);
    if (!sess?.party) {
      return interaction.reply({
        content: "Paste party first using `/settle party`.",
        ephemeral: true
      });
    }

    const name = interaction.options.getString("name", true).trim();
    const text = interaction.options.getString("text", true);

    const match = sess.party.players.find(
      p => p.name.toLowerCase() === name.toLowerCase()
    );

    if (!match) {
      return interaction.reply({
        content:
          `Name not found in party list: **${name}**.\n` +
          `Use the exact name from party analyzer.`,
        ephemeral: true
      });
    }

    const parsed = parseLooterAnalyzerText(text);
    sess.lootersByName.set(match.name, parsed.items ?? []);

    return interaction.reply({
      content:
        `Captured looter paste for **${match.name}**. Items parsed: **${(parsed.items ?? []).length}**.\n` +
        `Add another /settle looter or run \`/settle done\`.`,
      ephemeral: false
    });
  }

  // /settle done
  if (sub === "done") {
    const sess = sessions.get(interaction.channelId);
    if (!sess?.party) {
      return interaction.reply({
        content: "Paste party first using `/settle party`.",
        ephemeral: true
      });
    }

    if ((sess.world ?? "Secura") !== "Secura") {
      return interaction.reply({
        content: "MVP supports **Secura** only right now.",
        ephemeral: true
      });
    }

    try {
      const result = await computeCorrectedSettlementSecura({
        party: sess.party,
        lootersByName: sess.lootersByName
      });

      const transfersText = result.transfers.length
        ? result.transfers
            .map(t => `• **${t.from}** → **${t.to}**: **${fmtInt(t.amount)} gp**`)
            .join("\n")
        : "No transfers needed.";

      // Identify top 1-2 players by held loot value to show sell instructions (avoid huge embeds)
      const sortedByHeld = [...result.perPlayer].sort(
        (a, b) => (b.heldLootValue || 0) - (a.heldLootValue || 0)
      );

      const topNames = sortedByHeld.slice(0, 2).map(x => x.name);

      const sellSections = [];
      for (const nm of topNames) {
        const ins = result.sellInstructionsByPlayer.get(nm);
        if (!ins) continue;

        const buyLines = (ins.sellBuy ?? [])
          .slice(0, 15)
          .map(x => `• ${x.qty}x ${x.name} (BUY ${fmtInt(x.marketBuy ?? 0)} | NPC ${fmtInt(x.npcSell)})`)
          .join("\n") || "None.";

        const npcLines = (ins.sellNpc ?? [])
          .slice(0, 15)
          .map(x => `• ${x.qty}x ${x.name} (NPC ${fmtInt(x.npcSell)} | BUY ${fmtInt(x.marketBuy ?? 0)})`)
          .join("\n") || "None.";

        const unLines = (ins.unmatched ?? [])
          .slice(0, 10)
          .map(x => `• ${x.qty}x ${x.name}`)
          .join("\n") || "None.";

        sellSections.push({
          name: `Sell list for ${nm} — Market BUY`,
          value: truncate(buyLines)
        });
        sellSections.push({
          name: `Sell list for ${nm} — NPC`,
          value: truncate(npcLines)
        });
        if ((ins.unmatched ?? []).length) {
          sellSections.push({
            name: `Unmatched items for ${nm}`,
            value: truncate(unLines)
          });
        }
      }

      const unmatchedGlobal =
        (result.unmatchedItemNames ?? []).length
          ? result.unmatchedItemNames.slice(0, 20).map(x => `• ${x}`).join("\n")
          : "None.";

      const summaryLines = result.perPlayer
        .map(p => {
          const held = fmtInt(p.heldLootValue || 0);
          const sup = fmtInt(p.supplies || 0);
          const payout = fmtInt(p.fairPayout || 0);
          const delta = fmtInt(p.delta || 0);
          return `• **${p.name}** held ${held} | supplies ${sup} | fair payout ${payout} | delta ${delta}`;
        })
        .join("\n");

      const embed = new EmbedBuilder()
        .setTitle("Hunt Settlement — Corrected Loot (BUY vs NPC) + Equal Split")
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
          {
            name: "Per-player accounting",
            value: truncate(summaryLines)
          },
          {
            name: "Transfers (who sends who)",
            value: truncate(transfersText)
          },
          {
            name: "Unmatched item names (global)",
            value: truncate(unmatchedGlobal)
          }
        );

      // Add sell sections (top looters)
      for (const sec of sellSections) {
        embed.addFields(sec);
      }

      sessions.delete(interaction.channelId);
      return interaction.reply({ embeds: [embed] });
    } catch (e) {
      return interaction.reply({
        content: `Settlement failed: ${e.message}`,
        ephemeral: true
      });
    }
  }
});

client.once("ready", () => console.log(`Logged in as ${client.user.tag}`));
client.login(process.env.DISCORD_TOKEN);
