import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
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
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages]
});

// channelId -> { world, party, lootersByName: Map<string, items[]> }
const sessions = new Map();

// messageId -> { perPlayer, sellInstructionsByPlayer, updatedAt }
const sellBrowserState = new Map();

function fmtInt(n) {
  return new Intl.NumberFormat("en-US").format(Math.trunc(n));
}
function gp(n) {
  return `${fmtInt(n)} gp`;
}
function truncate(s, max = 1800) {
  const str = String(s ?? "");
  return str.length > max ? str.slice(0, max - 3) + "..." : str;
}
function monospaceBlock(text) {
  return "```text\n" + text + "\n```";
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

function buildSellEmbed(playerName, ins, updatedAt) {
  const sellBuy = (ins?.sellBuy ?? []).slice(0, 12);
  const sellNpc = (ins?.sellNpc ?? []).slice(0, 12);
  const unmatched = (ins?.unmatched ?? []).slice(0, 10);

  const buyLines = sellBuy.length
    ? sellBuy.map(x =>
        `${String(x.qty).padStart(4)}x ${String(x.name).padEnd(30)} | BUY ${fmtInt(x.marketBuy).padStart(8)} | NPC ${fmtInt(x.npcBuy).padStart(8)}`
      ).join("\n")
    : "(none)";

  const npcLines = sellNpc.length
    ? sellNpc.map(x =>
        `${String(x.qty).padStart(4)}x ${String(x.name).padEnd(30)} | NPC ${fmtInt(x.npcBuy).padStart(8)} | BUY ${fmtInt(x.marketBuy).padStart(8)}`
      ).join("\n")
    : "(none)";

  const embed = new EmbedBuilder()
    .setTitle(`🧺 Sell instructions — ${playerName}`)
    .setDescription(`Snapshot: ${updatedAt.toISOString()}\nRule: value per item = max(Market BUY, NPC BUY).`)
    .addFields(
      { name: "🟦 Sell on Market (BUY offer) — top items", value: monospaceBlock(truncate(buyLines, 900)), inline: false },
      { name: "🟨 Sell to NPC — top items", value: monospaceBlock(truncate(npcLines, 900)), inline: false }
    );

  if (unmatched.length) {
    const u = unmatched.map(x => `${x.qty}x ${x.name}`).join("\n");
    embed.addFields({ name: "⚠️ Unmatched items", value: monospaceBlock(truncate(u, 900)), inline: false });
  }

  return embed;
}

function buildSellBrowserRow(messageId, players, defaultName = null) {
  const options = players.slice(0, 25).map(p => ({
    label: p.name,
    value: p.name,
    default: defaultName ? p.name === defaultName : false
  }));

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`sellbrowser:${messageId}`)
    .setPlaceholder("Select your character…")
    .addOptions(options);

  return new ActionRowBuilder().addComponents(menu);
}

function groupTransfersByPayer(transfers) {
  const m = new Map();
  for (const t of transfers) {
    if (!m.has(t.from)) m.set(t.from, []);
    m.get(t.from).push({ to: t.to, amount: t.amount });
  }
  for (const [k, arr] of m.entries()) arr.sort((a, b) => b.amount - a.amount);
  return m;
}

client.on("interactionCreate", async interaction => {
  // 1) Autocomplete handler for /settle looter name
  if (interaction.isAutocomplete()) {
    try {
      const cmd = interaction.commandName;
      if (cmd !== "settle") return;

      const sub = interaction.options.getSubcommand(false);
      if (sub !== "looter") return;

      const sess = sessions.get(interaction.channelId);
      const party = sess?.party;
      const focused = interaction.options.getFocused(true);

      if (focused?.name !== "name") return;

      const q = String(focused.value ?? "").toLowerCase().trim();
      const players = party?.players ?? [];

      // filter by query, and only show up to 25
      const matches = players
        .map(p => p.name)
        .filter(name => (q ? name.toLowerCase().includes(q) : true))
        .slice(0, 25);

      // Must respond with {name,value} list
      return interaction.respond(matches.map(n => ({ name: n, value: n })));
    } catch (e) {
      // If autocomplete fails, respond with empty set to avoid Discord errors
      try { return interaction.respond([]); } catch {}
      return;
    }
  }

  // 2) Dropdown interactions (sell browser)
  if (interaction.isStringSelectMenu()) {
    try {
      const id = interaction.customId || "";
      if (!id.startsWith("sellbrowser:")) return;

      const msgId = id.split(":")[1];
      const state = sellBrowserState.get(msgId);
      if (!state) {
        return interaction.reply({ content: "This sell browser expired. Run a new /settle done.", ephemeral: true });
      }

      const selectedName = interaction.values?.[0];
      if (!selectedName) return interaction.reply({ content: "No selection.", ephemeral: true });

      const ins = state.sellInstructionsByPlayer.get(selectedName) || { sellBuy: [], sellNpc: [], unmatched: [] };
      const embed = buildSellEmbed(selectedName, ins, state.updatedAt);
      const row = buildSellBrowserRow(msgId, state.perPlayer, selectedName);

      return interaction.update({ embeds: [embed], components: [row] });
    } catch (e) {
      return interaction.reply({ content: `Select failed: ${e.message}`, ephemeral: true });
    }
  }

  // 3) Slash commands
  if (!interaction.isChatInputCommand()) return;

  // /price
  if (interaction.commandName === "price") {
    const item = interaction.options.getString("item", true);
    try {
      const p = await getPriceSecuraByName(item);
      if (!p.found) return interaction.reply({ content: `No data for **${item}** (${p.reason}).`, ephemeral: true });

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
        `2) Each player uses **/settle looter** (pick name from autocomplete, paste/attach)\n` +
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
          value: `Each player: **/settle looter** → click name from autocomplete → paste/attach analyzer (even if **Looted Items: None**)`
        });

      return interaction.reply({ embeds: [embed], ephemeral: false });
    } catch (e) {
      return interaction.reply({ content: `Party load failed: ${e.message}`, ephemeral: true });
    }
  }

  if (sub === "looter") {
    const sess = sessions.get(interaction.channelId);
    if (!sess?.party) return interaction.reply({ content: "Paste/attach party first using `/settle party`.", ephemeral: true });

    const nameInput = interaction.options.getString("name", true).trim();
    const match = sess.party.players.find(p => p.name.toLowerCase() === nameInput.toLowerCase());
    if (!match) {
      return interaction.reply({
        content: `Name not found in party list: **${nameInput}**. Use the autocomplete list.`,
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

      // Summary
      const summary = new EmbedBuilder()
        .setTitle("✅ Settlement complete — Corrected loot + Equal split")
        .setDescription(`World: **Secura** • Snapshot: ${result.updatedAt.toISOString()}`)
        .addFields({
          name: "💰 Totals",
          value:
            `Players: **${nPlayers}**\n` +
            `Corrected loot: **${gp(result.totalHeldLoot)}**\n` +
            `Supplies: **${gp(result.totalSupplies)}**\n` +
            `Net profit: **${gp(result.correctedNet)}**\n` +
            `Profit per player: **${gp(result.share)}**\n` +
            `Remainder: **${gp(remainder)}**`
        });

      const accountingLines = result.perPlayer.map(p => {
        const sign = p.delta >= 0 ? "+" : "-";
        return `${p.name.padEnd(16)} held ${fmtInt(p.heldLootValue).padStart(10)} | sup ${fmtInt(p.supplies).padStart(9)} | payout ${fmtInt(p.fairPayout).padStart(10)} | delta ${sign}${fmtInt(Math.abs(p.delta)).padStart(10)}`;
      });

      summary.addFields({ name: "🧮 Per-player accounting", value: monospaceBlock(truncate(accountingLines.join("\n"), 950)) });

      await interaction.reply({ embeds: [summary] });

      // Transfers (grouped)
      const transfersMap = groupTransfersByPayer(result.transfers);
      const transferLines = [];

      if (result.transfers.length === 0) {
        transferLines.push("No transfers needed.");
      } else {
        for (const [payer, arr] of transfersMap.entries()) {
          transferLines.push(`${payer}:`);
          for (const x of arr) transferLines.push(`  -> ${x.to}: ${fmtInt(x.amount)} gp`);
          transferLines.push("");
        }
      }

      const transfersEmbed = new EmbedBuilder()
        .setTitle("🏦 Transfers (who sends who)")
        .setDescription(monospaceBlock(truncate(transferLines.join("\n"), 1800)));

      await interaction.followUp({ embeds: [transfersEmbed] });

      // Sell browser (public)
      const browserIntro = new EmbedBuilder()
        .setTitle("🧺 Sell instructions browser")
        .setDescription(`Select your character from the dropdown.\nThis message updates in-place (visible to everyone).`);

      const browserMsg = await interaction.followUp({ embeds: [browserIntro], components: [] });
      const row = buildSellBrowserRow(browserMsg.id, result.perPlayer, null);
      await browserMsg.edit({ embeds: [browserIntro], components: [row] });

      sellBrowserState.set(browserMsg.id, {
        perPlayer: result.perPlayer.map(p => ({ name: p.name })),
        sellInstructionsByPlayer: result.sellInstructionsByPlayer,
        updatedAt: result.updatedAt
      });

      sessions.delete(interaction.channelId);
    } catch (e) {
      return interaction.reply({ content: `Settlement failed: ${e.message}`, ephemeral: true });
    }
  }
});

client.once("ready", () => console.log(`Logged in as ${client.user.tag}`));
client.login(process.env.DISCORD_TOKEN);
