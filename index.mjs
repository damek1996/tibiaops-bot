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

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// channelId -> active session
// session: { party, lootersByName: Map(name->items[]), world }
const sessions = new Map();

// channelId -> { createdAtMs, players: string[], sellInstructionsByPlayer: Map(name->instr) }
const instructionBoards = new Map();
const INSTRUCTION_TTL_MS = 30 * 60 * 1000;

function fmtInt(n) {
  return new Intl.NumberFormat("en-US").format(Math.trunc(n));
}

async function readInputTextFromTextOrFile(interaction, { textOptName, fileOptName, requireFile = false }) {
  const text = interaction.options.getString(textOptName, false);
  const file = interaction.options.getAttachment(fileOptName, false);

  if (text && text.trim().length) return text;

  if (file?.url) {
    const res = await fetch(file.url);
    if (!res.ok) throw new Error(`Failed to download attachment (${res.status})`);
    return await res.text();
  }

  if (requireFile) throw new Error(`Attach a .txt file in option: ${fileOptName}`);
  throw new Error("Provide text or attach a .txt file.");
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
      .setCustomId("split_instructions_select")
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
  lines.push("SELL TO NPC:");
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

function getSessionOrExplain(channelId) {
  const sess = sessions.get(channelId);
  if (!sess) return null;
  if (!sess.party) return null;
  return sess;
}

function partyNames(sess) {
  return sess?.party?.players?.map(p => p.name) ?? [];
}

function partyNameCanonical(sess, inputName) {
  const x = inputName.trim().toLowerCase();
  return sess.party.players.find(p => p.name.toLowerCase() === x)?.name ?? null;
}

client.on("interactionCreate", async interaction => {
  try {
    purgeOldBoards();

    // Instructions dropdown handler
    if (interaction.isStringSelectMenu() && interaction.customId === "split_instructions_select") {
      const pick = interaction.values?.[0] ?? "";
      const [channelId, playerName] = pick.split("::");
      if (!channelId || !playerName) {
        return interaction.reply({ ephemeral: true, content: "Invalid selection." });
      }

      const board = instructionBoards.get(channelId);
      if (!board) {
        return interaction.reply({ ephemeral: true, content: "Instruction board expired. Run /split_done again." });
      }

      const instr = board.sellInstructionsByPlayer.get(playerName);
      if (!instr) {
        return interaction.reply({ ephemeral: true, content: `No instruction data for ${playerName}.` });
      }

      const content = renderInstructions(playerName, instr);
      const row = buildInstructionSelect(channelId, board.players, playerName);

      return interaction.update({ content, components: [row] });
    }

    // Autocomplete for /split_looter name
    if (interaction.isAutocomplete()) {
      try {
        if (interaction.commandName !== "split_looter") return;

        const focused = interaction.options.getFocused(true);
        if (focused.name !== "name") return;

        const sess = sessions.get(interaction.channelId);
        if (!sess?.party?.players?.length) {
          return interaction.respond([{ name: "Run /split_party first", value: "Run /split_party first" }]);
        }

        const q = String(focused.value || "").toLowerCase().trim();

        // Hide already submitted names (nice UX)
        const submitted = new Set([...sess.lootersByName.keys()].map(x => x.toLowerCase()));
        const remaining = sess.party.players.map(p => p.name).filter(n => !submitted.has(n.toLowerCase()));

        const filtered = (q ? remaining.filter(n => n.toLowerCase().includes(q)) : remaining)
          .slice(0, 25)
          .map(n => ({ name: n, value: n }));

        return interaction.respond(filtered.length ? filtered : remaining.slice(0, 25).map(n => ({ name: n, value: n })));
      } catch {
        try { return interaction.respond([]); } catch {}
      }
      return;
    }

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

    // /split_party
    if (interaction.commandName === "split_party") {
      // create/reset session
      sessions.set(interaction.channelId, {
        world: "Secura",
        party: null,
        lootersByName: new Map()
      });

      const sess = sessions.get(interaction.channelId);

      try {
        const partyText = await readInputTextFromTextOrFile(interaction, {
          textOptName: "text",
          fileOptName: "file",
          requireFile: false
        });

        const party = parsePartyAnalyzerText(partyText);
        if (!party.players.length) {
          return interaction.reply({
            ephemeral: true,
            content: "Could not parse players/supplies. Paste the full Party Hunt Analyzer block."
          });
        }

        sess.party = party;
        sess.lootersByName.clear();

        const names = party.players.map(p => `${p.name} (supplies ${fmtInt(p.supplies)})`).join("\n");

        return interaction.reply({
          ephemeral: false,
          content:
            `Party loaded. Players: **${party.players.length}**\n` +
            `Now each player uses **/split_looter** → pick name → attach file.\n` +
            `When all are done, run **/split_done**.\n` +
            "```text\n" + names + "\n```"
        });
      } catch (e) {
        return interaction.reply({ ephemeral: true, content: `Party load failed: ${e.message}` });
      }
    }

    // /split_looter
    if (interaction.commandName === "split_looter") {
      const sess = getSessionOrExplain(interaction.channelId);
      if (!sess) {
        return interaction.reply({ ephemeral: true, content: "No active party here. Run /split_party first." });
      }

      const chosenName = interaction.options.getString("name", true);
      const canonical = partyNameCanonical(sess, chosenName);
      if (!canonical) {
        return interaction.reply({ ephemeral: true, content: `Name not in party roster: **${chosenName}**` });
      }

      const already = sess.lootersByName.has(canonical);

      try {
        const looterText = await readInputTextFromTextOrFile(interaction, {
          textOptName: "text",
          fileOptName: "file",
          requireFile: true
        });

        const parsed = parseLooterAnalyzerText(looterText);
        sess.lootersByName.set(canonical, parsed.items ?? []);

        const remaining = partyNames(sess).filter(n => !sess.lootersByName.has(n));

        return interaction.reply({
          ephemeral: false,
          content:
            `${already ? "Updated" : "Captured"} looter for **${canonical}**. ` +
            `Items parsed: **${(parsed.items ?? []).length}**\n` +
            `Remaining submissions: **${remaining.length}**` +
            (remaining.length ? ` (${remaining.join(", ")})` : "")
        });
      } catch (e) {
        return interaction.reply({ ephemeral: true, content: `Looter load failed: ${e.message}` });
      }
    }

    // /split_done
    if (interaction.commandName === "split_done") {
      await interaction.deferReply({ ephemeral: false });

      const sess = sessions.get(interaction.channelId);
      if (!sess?.party) return interaction.editReply("Paste party first using **/split_party**.");

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

        // Instruction board
        const players = result.perPlayer.map(p => p.name);
        instructionBoards.set(interaction.channelId, {
          createdAtMs: Date.now(),
          players,
          sellInstructionsByPlayer: result.sellInstructionsByPlayer
        });

        const first = players[0];
        const firstInstr = result.sellInstructionsByPlayer.get(first);
        const row = buildInstructionSelect(interaction.channelId, players, first);

        await interaction.followUp({
          content: firstInstr ? renderInstructions(first, firstInstr) : "No instructions available.",
          components: [row]
        });

        sessions.delete(interaction.channelId);
      } catch (e) {
        await interaction.editReply(`Settlement failed: ${e.message}`);
      }
    }
  } catch (e) {
    console.error(e);
    try {
      if (interaction.isRepliable()) {
        return interaction.reply({ content: `Error: ${e.message}`, ephemeral: true });
      }
    } catch {}
  }
});

client.once("ready", () => console.log(`Logged in as ${client.user.tag}`));
client.login(process.env.DISCORD_TOKEN);
