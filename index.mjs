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

// channelId -> { world, party, lootersByName: Map(playerName -> items[]), pendingLooterSelection: Map(userId -> name) }
const sessions = new Map();

function fmtInt(n) {
  return new Intl.NumberFormat("en-US").format(Math.trunc(n));
}

function chunkLinesToMessages(lines, maxChars = 1800) {
  const chunks = [];
  let cur = "";
  for (const line of lines) {
    // +1 for newline
    if ((cur.length + line.length + 1) > maxChars) {
      if (cur.trim().length) chunks.push(cur);
      cur = "";
    }
    cur += (cur.length ? "\n" : "") + line;
  }
  if (cur.trim().length) chunks.push(cur);
  return chunks;
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

function rosterNamesRemaining(sess) {
  if (!sess?.party?.players?.length) return [];
  const submitted = new Set([...sess.lootersByName.keys()].map(x => x.toLowerCase()));
  return sess.party.players
    .map(p => p.name)
    .filter(n => !submitted.has(n.toLowerCase()));
}

function buildLooterSelect(sess) {
  const remaining = rosterNamesRemaining(sess);
  const options = remaining.slice(0, 25).map(n => ({ label: n, value: n }));
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("settle_looter_select")
      .setPlaceholder(remaining.length ? "Select your character…" : "All looters already submitted")
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(options.length ? options : [{ label: "No names available", value: "__none__", default: true }])
      .setDisabled(!options.length)
  );
}

function formatPlayerInstructions(playerName, instr) {
  // Compact + includes per-item prices
  const lines = [];
  lines.push(`Hunt Sell Instructions — ${playerName}`);
  lines.push("");

  lines.push("SELL ON MARKET (highest BUY offer):");
  if (!instr.sellMarket?.length) {
    lines.push("• none");
  } else {
    for (const r of instr.sellMarket) {
      lines.push(
        `• ${r.qty}x ${r.name} | BUY ${fmtInt(r.buyOffer)} ea | total ${fmtInt(r.marketTotal)} gp`
      );
    }
  }

  lines.push("");
  lines.push("SELL TO NPC (best buyer):");
  if (!instr.sellNpc?.length) {
    lines.push("• none");
  } else {
    for (const r of instr.sellNpc) {
      const npcInfo = r.bestNpc ? ` | NPC ${r.bestNpc}` : "";
      lines.push(
        `• ${r.qty}x ${r.name} | NPC ${fmtInt(r.npcBuy)} ea | total ${fmtInt(r.npcTotal)} gp${npcInfo}`
      );
    }
  }

  if (instr.unmatched?.length) {
    lines.push("");
    lines.push("UNMATCHED (not priced):");
    for (const u of instr.unmatched) lines.push(`• ${u.qty}x ${u.name}`);
  }

  // turn into chunked codeblocks
  const chunks = chunkLinesToMessages(lines, 1700);
  return chunks.map(c => "```text\n" + c + "\n```");
}

client.on("interactionCreate", async interaction => {
  try {
    // Dropdown selection handler
    if (interaction.isStringSelectMenu() && interaction.customId === "settle_looter_select") {
      const sess = sessions.get(interaction.channelId);
      if (!sess?.party) {
        return interaction.reply({ ephemeral: true, content: "No active settlement here. Run /settle start." });
      }

      const chosen = interaction.values?.[0];
      if (!chosen || chosen === "__none__") {
        return interaction.reply({ ephemeral: true, content: "No character selected." });
      }

      sess.pendingLooterSelection ??= new Map();
      sess.pendingLooterSelection.set(interaction.user.id, chosen);

      return interaction.reply({
        ephemeral: true,
        content: `Selected **${chosen}**. Now run **/settle looter** and paste your analyzer text (no need to type name).`
      });
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

    if (interaction.commandName !== "settle") return;
    const sub = interaction.options.getSubcommand();

    if (sub === "start") {
      const world = interaction.options.getString("world") ?? "Secura";
      sessions.set(interaction.channelId, {
        world,
        party: null,
        lootersByName: new Map(),
        pendingLooterSelection: new Map()
      });

      return interaction.reply({
        ephemeral: false,
        content:
          `Settlement started for **${world}**.\n` +
          `1) Paste Party Hunt Analyzer with **/settle party**\n` +
          `2) Players submit looter logs using **/settle looter** (dropdown)\n` +
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
        sess.pendingLooterSelection.clear();

        const names = party.players.map(p => `${p.name} (supplies ${fmtInt(p.supplies)})`).join("\n");

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

      const typedName = interaction.options.getString("name", false);
      let rosterName = null;

      if (typedName && typedName.trim().length) {
        const x = typedName.trim().toLowerCase();
        rosterName = sess.party.players.find(p => p.name.toLowerCase() === x)?.name ?? null;
        if (!rosterName) {
          return interaction.reply({
            ephemeral: true,
            content: `Name not in party roster: **${typedName}**. Use dropdown: run /settle looter without name.`
          });
        }
      } else {
        rosterName = sess.pendingLooterSelection?.get(interaction.user.id) ?? null;
        if (!rosterName) {
          const row = buildLooterSelect(sess);
          return interaction.reply({ ephemeral: true, content: "Pick your character:", components: [row] });
        }
      }

      const already = sess.lootersByName.has(rosterName);

      try {
        const looterText = await readInputText(interaction);
        const parsed = parseLooterAnalyzerText(looterText);
        sess.lootersByName.set(rosterName, parsed.items ?? []);
        sess.pendingLooterSelection?.delete(interaction.user.id);

        const remaining = rosterNamesRemaining(sess);

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

        if (!result.transfers.length) {
          await interaction.followUp("```text\nTransfers\nNo transfers needed.\n```");
        } else {
          const t = result.transfers.map(x => `• ${x.from} → ${x.to}: ${fmtInt(x.amount)} gp`).join("\n");
          await interaction.followUp("```text\nTransfers (who sends who)\n" + t + "\n```");
        }

        // Sanity summary so you can confirm instruction generation ran
        const instrPlayers = [...result.sellInstructionsByPlayer.keys()].length;
        let marketItems = 0;
        let npcItems = 0;
        for (const v of result.sellInstructionsByPlayer.values()) {
          marketItems += (v.sellMarket?.length ?? 0);
          npcItems += (v.sellNpc?.length ?? 0);
        }
        await interaction.followUp(
          "```text\n" +
          `Instruction summary: players=${instrPlayers}, market-items=${marketItems}, npc-items=${npcItems}\n` +
          "```"
        );

        // Sell instructions per player (chunked)
        for (const p of result.perPlayer) {
          const instr = result.sellInstructionsByPlayer.get(p.name);
          if (!instr) continue;

          const msgs = formatPlayerInstructions(p.name, instr);
          for (const m of msgs) {
            await interaction.followUp(m);
          }
        }

        sessions.delete(interaction.channelId);
      } catch (e) {
        await interaction.editReply(`Settlement failed: ${e.message}`);
      }
    }
  } catch (e) {
    try {
      if (interaction.isRepliable()) return interaction.reply({ content: `Error: ${e.message}`, ephemeral: true });
    } catch {}
    console.error(e);
  }
});

client.once("ready", () => console.log(`Logged in as ${client.user.tag}`));
client.login(process.env.DISCORD_TOKEN);
