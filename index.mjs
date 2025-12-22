import "dotenv/config";
import { Client, GatewayIntentBits } from "discord.js";

import { getPriceSecuraByName, formatGold } from "./provider.mjs";
import {
  parsePartyAnalyzerText,
  parseLooterAnalyzerText,
  computeCorrectedSettlementSecura
} from "./settle.mjs";

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

// One settlement per channel
// channelId -> { world, party, lootersByName: Map(playerName -> items[]) }
const sessions = new Map();

function fmtInt(n) {
  return new Intl.NumberFormat("en-US").format(Math.trunc(n));
}

async function readInputText(interaction) {
  const text = interaction.options.getString("text", false);
  const file = interaction.options.getAttachment("file", false);

  if (text && text.trim().length) return text;

  if (file?.url) {
    const res = await fetch(file.url);
    if (!res.ok) throw new Error(`Failed to download attachment (${res.status})`);
    return await res.text();
  }

  throw new Error("Provide either text OR attach a .txt file.");
}

function findRosterName(party, nameInput) {
  const x = String(nameInput || "").trim().toLowerCase();
  return party.players.find(p => p.name.toLowerCase() === x)?.name ?? null;
}

client.on("interactionCreate", async interaction => {
  try {
    if (!interaction.isChatInputCommand()) return;

    // -------- /price --------
    if (interaction.commandName === "price") {
      const item = interaction.options.getString("item", true);
      try {
        const p = await getPriceSecuraByName(item);
        if (!p.found) {
          return interaction.reply({ content: `No data for **${item}** (${p.reason}).`, ephemeral: true });
        }
        return interaction.reply({
          ephemeral: true,
          content:
            `**${item}** (Secura)\n` +
            `Snapshot: ${p.updatedAt.toISOString()}\n` +
            `Market BUY (you sell instantly): **${formatGold(p.buy)} gp**\n` +
            `Market SELL (you buy instantly): **${formatGold(p.sell)} gp**`
        });
      } catch (e) {
        return interaction.reply({ content: `Price failed: ${e.message}`, ephemeral: true });
      }
    }

    // -------- /settle --------
    if (interaction.commandName !== "settle") return;

    const sub = interaction.options.getSubcommand();

    if (sub === "start") {
      const world = interaction.options.getString("world") ?? "Secura";
      sessions.set(interaction.channelId, { world, party: null, lootersByName: new Map() });

      return interaction.reply({
        ephemeral: false,
        content:
          `Settlement started for **${world}**.\n` +
          `1) Paste Party Hunt Analyzer with **/settle party**\n` +
          `2) Each player pastes their analyzer with **/settle looter** (even if Looted Items: None)\n` +
          `3) Run **/settle done**`
      });
    }

    if (sub === "party") {
      const sess = sessions.get(interaction.channelId);
      if (!sess) return interaction.reply({ content: "Run **/settle start** first.", ephemeral: true });

      try {
        const partyText = await readInputText(interaction);
        const party = parsePartyAnalyzerText(partyText);

        if (!party.players.length) {
          return interaction.reply({
            ephemeral: true,
            content: "Could not parse players/supplies from Party Hunt Analyzer. Paste the full party block."
          });
        }

        sess.party = party;

        const names = party.players
          .map(p => `${p.name} (supplies ${fmtInt(p.supplies)})`)
          .join("\n");

        return interaction.reply({
          ephemeral: false,
          content:
            `Party loaded. Players: **${party.players.length}**\n` +
            "```text\n" + names + "\n```"
        });
      } catch (e) {
        return interaction.reply({ content: `Party load failed: ${e.message}`, ephemeral: true });
      }
    }

    if (sub === "looter") {
      const sess = sessions.get(interaction.channelId);
      if (!sess?.party) {
        return interaction.reply({ content: "Paste party first using **/settle party**.", ephemeral: true });
      }

      const nameInput = interaction.options.getString("name", true);
      const rosterName = findRosterName(sess.party, nameInput);
      if (!rosterName) {
        const roster = sess.party.players.map(p => p.name).join(", ");
        return interaction.reply({
          ephemeral: true,
          content: `Name not found in party list: **${nameInput}**\nRoster: ${roster}`
        });
      }

      try {
        const looterText = await readInputText(interaction);
        const parsed = parseLooterAnalyzerText(looterText);
        sess.lootersByName.set(rosterName, parsed.items ?? []);

        return interaction.reply({
          ephemeral: false,
          content: `Looter captured for **${rosterName}**. Items parsed: **${(parsed.items ?? []).length}**`
        });
      } catch (e) {
        return interaction.reply({ content: `Looter load failed: ${e.message}`, ephemeral: true });
      }
    }

    if (sub === "done") {
      // MUST defer, settlement can take time due to API limits
      await interaction.deferReply({ ephemeral: false });

      const sess = sessions.get(interaction.channelId);
      if (!sess?.party) return interaction.editReply("Paste party first using **/settle party**.");

      const missing = sess.party.players
        .filter(p => !sess.lootersByName.has(p.name))
        .map(p => p.name);

      if (missing.length) return interaction.editReply(`Missing looter paste for: ${missing.join(", ")}`);

      try {
        // FAST-mode settlement: NPC baseline + limited market checks
        const result = await computeCorrectedSettlementSecura({
          party: sess.party,
          lootersByName: sess.lootersByName,
          topKMarketChecks: 5
        });

        const n = result.perPlayer.length;
        const remainder = result.correctedNet - (result.share * n);

        const marketCompleted = result.marketCheck?.completed ?? 0;
        const marketAttempted = result.marketCheck?.attempted ?? 0;

        const summary =
          `Hunt Settlement — Corrected Loot (NPC baseline + Market depth for top items) + Equal Split\n` +
          `World: Secura | Updated: ${result.updatedAt.toISOString()}\n\n` +
          `Totals\n` +
          `Corrected total loot: ${fmtInt(result.totalHeldLoot)} gp\n` +
          `Total supplies: ${fmtInt(result.totalSupplies)} gp\n` +
          `Corrected net: ${fmtInt(result.correctedNet)} gp\n` +
          `Profit per player: ${fmtInt(result.share)} gp\n` +
          `Remainder: ${fmtInt(remainder)} gp\n` +
          `Market checks used: ${marketCompleted}/${marketAttempted} (API limit: 5/min)\n\n` +
          `Per-player accounting\n` +
          result.perPlayer.map(p =>
            `• ${p.name} held ${fmtInt(p.heldLootValue)} | supplies ${fmtInt(p.supplies)} | payout ${fmtInt(p.fairPayout)} | delta ${fmtInt(p.delta)}`
          ).join("\n");

        await interaction.editReply("```text\n" + summary + "\n```");

        if (!result.transfers.length) {
          await interaction.followUp("```text\nTransfers\nNo transfers needed.\n```");
        } else {
          const t = result.transfers
            .map(x => `• ${x.from} → ${x.to}: ${fmtInt(x.amount)} gp`)
            .join("\n");
          await interaction.followUp("```text\nTransfers (who sends who)\n" + t + "\n```");
        }

        // Optional: show if market checks were blocked
        const errs = result.marketCheck?.errors ?? [];
        if (errs.length) {
          await interaction.followUp({
            ephemeral: true,
            content: `Market check warnings:\n\`\`\`\n${errs.slice(0, 3).join("\n")}\n\`\`\``
          });
        }

        sessions.delete(interaction.channelId);
      } catch (e) {
        await interaction.editReply(`Settlement failed: ${e.message}`);
      }
    }
  } catch (e) {
    // Last-resort guard: prevents bot from dying on unhandled exceptions
    try {
      if (interaction.isRepliable()) {
        return interaction.reply({ content: `Error: ${e.message}`, ephemeral: true });
      }
    } catch {}
    console.error(e);
  }
});

client.once("ready", () => console.log(`Logged in as ${client.user.tag}`));
client.login(process.env.DISCORD_TOKEN);
