import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  StringSelectMenuBuilder
} from "discord.js";

import { getPriceSecuraByName, formatGold } from "./provider.mjs";
import {
  parsePartyAnalyzerText,
  parseLooterAnalyzerText,
  computeCorrectedSettlementSecura
} from "./settle.mjs";

/* =======================
   CLIENT
======================= */

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

/* =======================
   STATE
======================= */

// channelId → active settlement session
const sessions = new Map();

// channelId → instruction board
const instructionBoards = new Map();
const INSTRUCTION_TTL_MS = 30 * 60 * 1000;

/* =======================
   HELPERS
======================= */

function fmtInt(n) {
  return Math.trunc(n).toString();
}

async function readInputText(interaction) {
  const text = interaction.options.getString("text", false);
  const file = interaction.options.getAttachment("file", false);

  if (text && text.trim()) return text;

  if (file?.url) {
    const res = await fetch(file.url);
    if (!res.ok) throw new Error("Failed to download attachment");
    return await res.text();
  }

  throw new Error("Provide text or attach a .txt file.");
}

function rosterRemaining(sess) {
  const submitted = new Set([...sess.lootersByName.keys()].map(x => x.toLowerCase()));
  return sess.party.players
    .map(p => p.name)
    .filter(n => !submitted.has(n.toLowerCase()));
}

function buildLooterSelect(sess) {
  const names = rosterRemaining(sess);

  const options = names.slice(0, 25).map(n => ({
    label: n,
    value: n
  }));

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("settle_looter_select")
      .setPlaceholder("Select your character…")
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(options.length ? options : [{
        label: "All looters submitted",
        value: "__none__",
        default: true
      }])
      .setDisabled(!options.length)
  );
}

function buildInstructionSelect(channelId, players, selected) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("settle_instructions_select")
      .setPlaceholder("Pick a player to view sell instructions…")
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(
        players.map(p => ({
          label: p,
          value: `${channelId}::${p}`,
          default: p === selected
        }))
      )
  );
}

function renderInstructions(player, instr) {
  const lines = [];
  lines.push(`Sell Instructions — ${player}`);
  lines.push("");

  lines.push("SELL ON MARKET (highest BUY offer):");
  if (!instr.sellMarket.length) lines.push("• none");
  for (const r of instr.sellMarket) {
    lines.push(`• ${r.qty}x ${r.name} @ ${fmtInt(r.buyOffer)} = ${fmtInt(r.marketTotal)} gp`);
  }

  lines.push("");
  lines.push("SELL TO NPC:");
  if (!instr.sellNpc.length) lines.push("• none");
  for (const r of instr.sellNpc) {
    lines.push(`• ${r.qty}x ${r.name} @ ${fmtInt(r.npcBuy)} = ${fmtInt(r.npcTotal)} gp`);
  }

  if (instr.unmatched.length) {
    lines.push("");
    lines.push("UNMATCHED:");
    for (const r of instr.unmatched) {
      lines.push(`• ${r.qty}x ${r.name}`);
    }
  }

  return "```text\n" + lines.join("\n") + "\n```";
}

/* =======================
   INTERACTIONS
======================= */

client.on("interactionCreate", async interaction => {
  try {

    /* ===== instruction dropdown ===== */
    if (interaction.isStringSelectMenu() &&
        interaction.customId === "settle_instructions_select") {

      const [channelId, name] = interaction.values[0].split("::");
      const board = instructionBoards.get(channelId);

      if (!board) {
        return interaction.reply({ ephemeral: true, content: "Instruction board expired." });
      }

      const instr = board.sellInstructionsByPlayer.get(name);
      if (!instr) {
        return interaction.reply({ ephemeral: true, content: "No data for player." });
      }

      return interaction.update({
        content: renderInstructions(name, instr),
        components: [buildInstructionSelect(channelId, board.players, name)]
      });
    }

    /* ===== looter dropdown ===== */
    if (interaction.isStringSelectMenu() &&
        interaction.customId === "settle_looter_select") {

      const sess = sessions.get(interaction.channelId);
      if (!sess) {
        return interaction.reply({ ephemeral: true, content: "No active settlement." });
      }

      const name = interaction.values[0];
      if (name === "__none__") return;

      sess.pendingLooterByUser.set(interaction.user.id, name);

      return interaction.reply({
        ephemeral: true,
        content: `Selected **${name}**. Now run /settle looter and paste analyzer.`
      });
    }

    if (!interaction.isChatInputCommand()) return;

    /* ===== /price ===== */
    if (interaction.commandName === "price") {
      const item = interaction.options.getString("item", true);
      const p = await getPriceSecuraByName(item);

      if (!p.found) {
        return interaction.reply({ ephemeral: true, content: "Item not found." });
      }

      return interaction.reply({
        ephemeral: true,
        content:
          `**${item}** (Secura)\n` +
          `Market BUY: ${formatGold(p.buy)} gp\n` +
          `NPC BUY: ${formatGold(p.npc)} gp`
      });
    }

    if (interaction.commandName !== "settle") return;
    const sub = interaction.options.getSubcommand();

    /* ===== start ===== */
    if (sub === "start") {
      sessions.set(interaction.channelId, {
        party: null,
        lootersByName: new Map(),
        pendingLooterByUser: new Map()
      });

      return interaction.reply(
        "Settlement started.\n" +
        "1) /settle party\n" +
        "2) /settle looter\n" +
        "3) /settle done"
      );
    }

    /* ===== party ===== */
    if (sub === "party") {
      const sess = sessions.get(interaction.channelId);
      if (!sess) return interaction.reply({ ephemeral: true, content: "Run /settle start first." });

      const text = await readInputText(interaction);
      const party = parsePartyAnalyzerText(text);

      if (!party.players.length) {
        return interaction.reply({ ephemeral: true, content: "Could not parse party." });
      }

      sess.party = party;
      sess.lootersByName.clear();
      sess.pendingLooterByUser.clear();

      return interaction.reply(
        "Party loaded:\n```text\n" +
        party.players.map(p => `${p.name} | supplies ${fmtInt(p.supplies)}`).join("\n") +
        "\n```"
      );
    }

    /* ===== looter ===== */
    if (sub === "looter") {
      const sess = sessions.get(interaction.channelId);
      if (!sess?.party) {
        return interaction.reply({ ephemeral: true, content: "Paste party first." });
      }

      let name = interaction.options.getString("name", false);
      if (!name) {
        name = sess.pendingLooterByUser.get(interaction.user.id);
        if (!name) {
          return interaction.reply({
            ephemeral: true,
            content: "Select your character:",
            components: [buildLooterSelect(sess)]
          });
        }
      }

      const text = await readInputText(interaction);
      const parsed = parseLooterAnalyzerText(text);

      sess.lootersByName.set(name, parsed.items ?? []);
      sess.pendingLooterByUser.delete(interaction.user.id);

      return interaction.reply(`Captured looter for **${name}**.`);
    }

    /* ===== done ===== */
    if (sub === "done") {
      await interaction.deferReply();

      const sess = sessions.get(interaction.channelId);
      if (!sess?.party) return interaction.editReply("Missing party.");

      const missing = sess.party.players
        .map(p => p.name)
        .filter(n => !sess.lootersByName.has(n));

      if (missing.length) {
        return interaction.editReply("Missing looters: " + missing.join(", "));
      }

      const result = await computeCorrectedSettlementSecura(sess);

      await interaction.editReply(
        "```text\n" +
        result.summaryText +
        "\n```"
      );

      // transfers (optimized)
      if (result.transfers.length) {
        const grouped = new Map();
        for (const t of result.transfers) {
          if (!grouped.has(t.from)) grouped.set(t.from, []);
          grouped.get(t.from).push(t);
        }

        const lines = [];
        for (const [from, arr] of grouped.entries()) {
          lines.push(`${from}:`);
          for (const t of arr) {
            lines.push(`transfer ${fmtInt(t.amount)} to ${t.to}`);
          }
          lines.push("");
        }

        await interaction.followUp("```text\n" + lines.join("\n") + "\n```");
      }

      instructionBoards.set(interaction.channelId, {
        createdAtMs: Date.now(),
        players: result.players,
        sellInstructionsByPlayer: result.sellInstructionsByPlayer
      });

      const first = result.players[0];
      await interaction.followUp({
        content: renderInstructions(first, result.sellInstructionsByPlayer.get(first)),
        components: [buildInstructionSelect(interaction.channelId, result.players, first)]
      });

      sessions.delete(interaction.channelId);
    }

  } catch (e) {
    console.error(e);
    if (interaction.isRepliable()) {
      try {
        await interaction.reply({ ephemeral: true, content: `Error: ${e.message}` });
      } catch {}
    }
  }
});

/* =======================
   LOGIN
======================= */

client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.login(process.env.DISCORD_TOKEN);
