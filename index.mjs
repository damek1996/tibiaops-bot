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

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

// channelId -> settlement session state during collection
const sessions = new Map();

// channelId -> { createdAtMs, players: string[], sellInstructionsByPlayer: Map(name -> instr) }
const instructionBoards = new Map();
const INSTRUCTION_TTL_MS = 30 * 60 * 1000;

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

function purgeOldBoards() {
  const now = Date.now();
  for (const [channelId, b] of instructionBoards.entries()) {
    if (!b?.createdAtMs || (now - b.createdAtMs) > INSTRUCTION_TTL_MS) instructionBoards.delete(channelId);
  }
}

function buildInstructionSelect(channelId, players, selected = null) {
  const options = players.slice(0, 25).map(name => ({
    label: name,
    value: `${channelId}::${name}`,
    default: selected === name
  }));

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("settle_instructions_select")
      .setPlaceholder("Pick a player to view sell instructions…")
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(options)
  );
}

function renderInstructions(playerName, instr) {
  const lines = [];
  lines.push(`Sell Instructions — ${playerName}`);
  lines.push("");

  lines.push("SELL ON MARKET (highest BUY offer):");
  if (!instr.sellMarket?.length) lines.push("• none");
  else {
    for (const r of instr.sellMarket.slice(0, 35)) {
      lines.push(`• ${r.qty}x ${r.name} | BUY ${fmtInt(r.buyOffer)} ea | total ${fmtInt(r.marketTotal)} gp`);
    }
    if (instr.sellMarket.length > 35) lines.push(`…and ${instr.sellMarket.length - 35} more`);
  }

  lines.push("");
  lines.push("SELL TO NPC (best buyer):");
  if (!instr.sellNpc?.length) lines.push("• none");
  else {
    for (const r of instr.sellNpc.slice(0, 35)) {
      const npcInfo = r.bestNpc ? ` | NPC ${r.bestNpc}` : "";
      lines.push(`• ${r.qty}x ${r.name} | NPC ${fmtInt(r.npcBuy)} ea | total ${fmtInt(r.npcTotal)} gp${npcInfo}`);
    }
    if (instr.sellNpc.length > 35) lines.push(`…and ${instr.sellNpc.length - 35} more`);
  }

  if (instr.unmatched?.length) {
    lines.push("");
    lines.push("UNMATCHED (not priced):");
    for (const u of instr.unmatched.slice(0, 25)) lines.push(`• ${u.qty}x ${u.name}`);
    if (instr.unmatched.length > 25) lines.push(`…and ${instr.unmatched.length - 25} more`);
  }

  let out = lines.join("\n");
  if (out.length > 1800) out = out.slice(0, 1800) + "\n…(truncated)";
  return "```text\n" + out + "\n```";
}

function rosterNames(sess) {
  return sess?.party?.players?.map(p => p.name) ?? [];
}

function canonicalRosterName(sess, input) {
  const x = (input ?? "").trim().toLowerCase();
  return sess.party.players.find(p => p.name.toLowerCase() === x)?.name ?? null;
}

client.on("interactionCreate", async interaction => {
  try {
    purgeOldBoards();

    // === AUTOCOMPLETE: /settle looter name ===
    if (interaction.isAutocomplete()) {
      if (interaction.commandName !== "settle") return;
      const sub = interaction.options.getSubcommand(false);
      if (sub !== "looter") return;

      const sess = sessions.get(interaction.channelId);
      if (!sess?.party?.players?.length) {
        return interaction.respond([]);
      }

      const focused = (interaction.options.getFocused() ?? "").toLowerCase();
      const submitted = new Set([...sess.lootersByName.keys()].map(x => x.toLowerCase()));
      const remaining = sess.party.players
        .map(p => p.name)
        .filter(n => !submitted.has(n.toLowerCase()));

      const list = (focused
        ? remaining.filter(n => n.toLowerCase().includes(focused))
        : remaining
      )
        .slice(0, 25)
        .map(n => ({ name: n, value: n }));

      return interaction.respond(list);
    }

    // Instructions dropdown handler
    if (interaction.isStringSelectMenu() && interaction.customId === "settle_instructions_select") {
      const pick = interaction.values?.[0] ?? "";
      const [channelId, playerName] = pick.split("::");
      if (!channelId || !playerName) {
        return interaction.reply({ ephemeral: true, content: "Invalid selection." });
      }

      const board = instructionBoards.get(channelId);
      if (!board) {
        return interaction.reply({ ephemeral: true, content: "Instruction board expired. Run /settle done again." });
      }

      const instr = board.sellInstructionsByPlayer.get(playerName);
      if (!instr) {
        return interaction.reply({ ephemeral: true, content: `No instruction data for ${playerName}.` });
      }

      const content = renderInstructions(playerName, instr);
      const row = buildInstructionSelect(channelId, board.players, playerName);

      return interaction.update({ content, components: [row] });
    }

    if (!interaction.isChatInputCommand()) return;

    // /price (zostawiamy bo się przydaje)
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
            `Market BUY offer: **${formatGold(p.buy)} gp**\n` +
            `NPC buy (best): **${formatGold(p.npc)} gp**`
        });
      } catch (e) {
        return interaction.reply({ content: `Price failed: ${e.message}`, ephemeral: true });
      }
    }

    if (interaction.commandName !== "settle") return;
    const sub = interaction.options.getSubcommand();

    if (sub === "start") {
      const world = interaction.options.getString("world") ?? "Secura";
      sessions.set(interaction.channelId, {
        world,
        party: null,
        lootersByName: new Map()
      });

      return interaction.reply({
        ephemeral: false,
        content:
          `Settlement started for **${world}**.\n` +
          `1) Paste Party Hunt Analyzer with **/settle party**\n` +
          `2) Each player runs **/settle looter** and selects name (autocomplete) + pastes/attaches log\n` +
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
        sess.lootersByName.clear();

        const names = party.players.map(p => `${p.name} (supplies ${fmtInt(p.supplies)})`).join("\n");
        return interaction.reply({
          ephemeral: false,
          content: `Party loaded. Players: **${party.players.length}**\n` + "```text\n" + names + "\n```"
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

      const chosen = interaction.options.getString("name", true);
      const rosterName = canonicalRosterName(sess, chosen);
      if (!rosterName) {
        return interaction.reply({ ephemeral: true, content: `Name not in party roster: **${chosen}**` });
      }

      const already = sess.lootersByName.has(rosterName);

      try {
        const looterText = await readInputText(interaction);
        const parsed = parseLooterAnalyzerText(looterText);
        sess.lootersByName.set(rosterName, parsed.items ?? []);

        const remaining = rosterNames(sess).filter(n => !sess.lootersByName.has(n));

        return interaction.reply({
          ephemeral: false,
          content:
            `${already ? "Updated" : "Captured"} looter for **${rosterName}**. Items parsed: **${(parsed.items ?? []).length}**\n` +
            `Remaining submissions: **${remaining.length}**` +
            (remaining.length ? ` (${remaining.join(", ")})` : "")
        });
      } catch (e) {
        return interaction.reply({ content: `Looter load failed: ${e.message}`, ephemeral: true });
      }
    }

    if (sub === "done") {
      await interaction.deferReply({ ephemeral: false });

      const sess = sessions.get(interaction.channelId);
      if (!sess?.party) return interaction.editReply("Paste party first using **/settle party**.");

      const missing = sess.party.players.filter(p => !sess.lootersByName.has(p.name)).map(p => p.name);
      if (missing.length) return interaction.editReply(`Missing looter paste for: ${missing.join(", ")}`);

      try {
        const result = await computeCorrectedSettlementSecura({
          party: sess.party,
          lootersByName: sess.lootersByName
        });

        const n = result.perPlayer.length;
        const remainder = result.correctedNet - (result.share * n);

        const summary =
          `Hunt Settlement — Corrected Loot (Market BUY offer vs NPC buy) + Equal Split\n` +
          `World: Secura | Updated: ${result.updatedAt.toISOString()}\n\n` +
          `Totals\n` +
          `Corrected total loot: ${fmtInt(result.totalHeldLoot)} gp\n` +
          `Total supplies: ${fmtInt(result.totalSupplies)} gp\n` +
          `Corrected net: ${fmtInt(result.correctedNet)} gp\n` +
          `Profit per player: ${fmtInt(result.share)} gp\n` +
          `Remainder: ${fmtInt(remainder)} gp\n\n` +
          `Per-player accounting\n` +
          result.perPlayer.map(p =>
            `• ${p.name} held ${fmtInt(p.heldLootValue)} | supplies ${fmtInt(p.supplies)} | payout ${fmtInt(p.fairPayout)} | delta ${fmtInt(p.delta)}`
          ).join("\n");

        await interaction.editReply("```text\n" + summary + "\n```");

        // Grouped transfers copy/paste
        if (!result.transfers.length) {
          await interaction.followUp("```text\nTransfers\nNo transfers needed.\n```");
        } else {
          const byFrom = new Map();
          for (const t of result.transfers) {
            if (!byFrom.has(t.from)) byFrom.set(t.from, []);
            byFrom.get(t.from).push(t);
          }

          const senders = [...byFrom.keys()].sort((a, b) => {
            const sumA = byFrom.get(a).reduce((s, x) => s + Math.trunc(x.amount), 0);
            const sumB = byFrom.get(b).reduce((s, x) => s + Math.trunc(x.amount), 0);
            return sumB - sumA;
          });

          const lines = [];
          lines.push("Transfers (copy/paste):");
          lines.push("");

          for (const sender of senders) {
            lines.push(`${sender}:`);
            const arr = byFrom.get(sender).slice().sort((x, y) => Math.trunc(y.amount) - Math.trunc(x.amount));
            for (const x of arr) {
              lines.push(`transfer ${Math.trunc(x.amount)} to ${x.to}`);
            }
            lines.push("");
          }

          while (lines.length && lines[lines.length - 1] === "") lines.pop();
          await interaction.followUp("```text\n" + lines.join("\n") + "\n```");
        }

        // Instructions dropdown
        const players = result.perPlayer.map(p => p.name);
        instructionBoards.set(interaction.channelId, {
          createdAtMs: Date.now(),
          players,
          sellInstructionsByPlayer: result.sellInstructionsByPlayer
        });

        const first = players[0];
        const firstInstr = result.sellInstructionsByPlayer.get(first);
        const row = buildInstructionSelect(interaction.channelId, players, first);
        const content = firstInstr ? renderInstructions(first, firstInstr) : "No instructions available.";

        await interaction.followUp({ content, components: [row] });

        sessions.delete(interaction.channelId);
      } catch (e) {
        await interaction.editReply(`Settlement failed: ${e.message}`);
      }
    }
  } catch (e) {
    console.error(e);
    try {
      if (interaction.isRepliable()) return interaction.reply({ content: `Error: ${e.message}`, ephemeral: true });
    } catch {}
  }
});

client.once("ready", () => console.log(`Logged in as ${client.user.tag}`));
client.login(process.env.DISCORD_TOKEN);
