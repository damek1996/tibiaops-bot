import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder
} from "discord.js";

import { initDb, addAlert, listAlerts, removeAlert, getAllAlerts } from "./db.js";
import { fetchMarketSnapshotSecura, normItemName, parseGold, formatGold } from "./provider.js";
import { parseAnalyzerText, computeSettlementSecura } from "./settle.js";

const db = initDb();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages]
});

let lastSnapshot = { updatedAt: null, items: new Map() };

// In-memory settlement sessions: channelId -> { world, roles[], idx, players[] }
const settleSessions = new Map();

function fmt(n) {
  return new Intl.NumberFormat("en-US").format(Math.trunc(n));
}

/* ------------------ market refresh (alerts) ------------------ */

async function refreshSnapshotAndTrigger() {
  try {
    const alerts = getAllAlerts(db);
    const uniqueItemNames = [...new Set(alerts.map(a => a.item_display))];
    if (!uniqueItemNames.length) return;

    const snap = await fetchMarketSnapshotSecura(uniqueItemNames);
    lastSnapshot = snap;

    for (const a of alerts) {
      const key = normItemName(a.item_display);
      const data = lastSnapshot.items.get(key);
      if (!data) continue;

      const price = a.type === "buy" ? data.buy : data.sell;
      if (price == null) continue;

      const hit =
        (a.direction === "below" && price <= a.threshold) ||
        (a.direction === "above" && price >= a.threshold);

      if (!hit) continue;

      const msg =
        `Market Alert — Secura\n` +
        `Item: ${a.item_display}\n` +
        `Rule: ${a.type} ${a.direction} ${formatGold(a.threshold)}\n` +
        `Now: ${formatGold(price)}\n` +
        `Updated: ${lastSnapshot.updatedAt?.toISOString?.() ?? "n/a"}`;

      try {
        if (a.channel_id) {
          const ch = await client.channels.fetch(a.channel_id);
          if (ch) await ch.send(msg);
        } else {
          const user = await client.users.fetch(a.user_id);
          await user.send(msg);
        }
      } catch {}
    }
  } catch (err) {
    console.error("Refresh error:", err.message);
  }
}

/* ------------------ commands ------------------ */

client.on("interactionCreate", async interaction => {
  // Buttons (settle flow)
  if (interaction.isButton()) {
    const sess = settleSessions.get(interaction.channelId);
    if (!sess) return interaction.reply({ content: "No active settlement session.", ephemeral: true });

    if (interaction.customId === "settle_cancel") {
      settleSessions.delete(interaction.channelId);
      return interaction.reply({ content: "Settlement cancelled.", ephemeral: true });
    }

    if (interaction.customId === "settle_add") {
      sess.idx += 1;
      const nextRole = sess.roles[sess.idx] ?? `PLAYER${sess.idx + 1}`;
      return interaction.reply({
        content: `OK. **${nextRole}**: use \`/settle paste\` and paste your analyzer now.`,
        ephemeral: false
      });
    }

    if (interaction.customId === "settle_calc") {
      try {
        if ((sess.world ?? "Secura") !== "Secura") {
          return interaction.reply({ content: "MVP supports world **Secura** only right now.", ephemeral: true });
        }

        const result = await computeSettlementSecura(sess.players);

        const transfersText = result.transfers.length
          ? result.transfers.map(t => `• **${t.from}** → **${t.to}**: **${fmt(t.amount)} gp**`).join("\n")
          : "No transfers needed.";

        const buyText = result.sellBuy.length
          ? result.sellBuy.slice(0, 20).map(x => `• ${x.qty}x ${x.name} (BUY ${fmt(x.marketBuy ?? 0)} | NPC ${fmt(x.npcSell)})`).join("\n")
          : "None.";

        const npcText = result.sellNpc.length
          ? result.sellNpc.slice(0, 20).map(x => `• ${x.qty}x ${x.name} (NPC ${fmt(x.npcSell)} | BUY ${fmt(x.marketBuy ?? 0)})`).join("\n")
          : "None.";

        const embed = new EmbedBuilder()
          .setTitle("Hunt Settlement — Secura (BUY vs NPC)")
          .setDescription(`Updated: ${result.updatedAt.toISOString()}`)
          .addFields(
            {
              name: "Totals",
              value:
                `Loot (best liquidation): **${fmt(result.totalLootValue)} gp**\n` +
                `Supplies: **${fmt(result.totalSupplies)} gp**\n` +
                `Net: **${fmt(result.totalNet)} gp**\n` +
                `Share each (${sess.players.length}): **${fmt(result.share)} gp**`
            },
            { name: "Transfers", value: transfersText.slice(0, 1024) },
            { name: `Loot holder: ${result.lootHolder} — SELL TO MARKET BUY`, value: buyText.slice(0, 1024) },
            { name: `Loot holder: ${result.lootHolder} — SELL TO NPC`, value: npcText.slice(0, 1024) }
          );

        settleSessions.delete(interaction.channelId);
        return interaction.reply({ embeds: [embed] });
      } catch (e) {
        return interaction.reply({ content: `Settlement failed: ${e.message}`, ephemeral: true });
      }
    }

    return;
  }

  // Slash commands
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "price") {
    const item = interaction.options.getString("item", true);
    const key = normItemName(item);

    let data = lastSnapshot.items.get(key);

    if (!data) {
      const snap = await fetchMarketSnapshotSecura([item]);
      lastSnapshot = snap;
      data = snap.items.get(key);
    }

    if (!data) {
      return interaction.reply({
        content: `No market data for **${item}**.`,
        ephemeral: true
      });
    }

    return interaction.reply({
      content:
        `**Secura — ${item}**\n` +
        `Buy: ${data.buy != null ? formatGold(data.buy) : "n/a"}\n` +
        `Sell: ${data.sell != null ? formatGold(data.sell) : "n/a"}\n` +
        `Updated: ${lastSnapshot.updatedAt?.toISOString?.() ?? "n/a"}`,
      ephemeral: true
    });
  }

  if (interaction.commandName === "alert") {
    const sub = interaction.options.getSubcommand();

    if (sub === "add") {
      const item = interaction.options.getString("item", true);
      const type = interaction.options.getString("type", true);
      const direction = interaction.options.getString("direction", true);
      const priceStr = interaction.options.getString("price", true);
      const sendToChannel = interaction.options.getBoolean("send_to_channel") ?? false;

      const threshold = parseGold(priceStr);
      if (threshold == null) {
        return interaction.reply({ content: "Invalid price format. Examples: 140kk, 120k, 100000", ephemeral: true });
      }

      addAlert(db, {
        user_id: interaction.user.id,
        item_norm: normItemName(item),
        item_display: item,
        type,
        direction,
        threshold,
        channel_id: sendToChannel ? interaction.channelId : null,
        created_at: Date.now()
      });

      return interaction.reply({ content: `Alert added for **${item}**.`, ephemeral: true });
    }

    if (sub === "list") {
      const rows = listAlerts(db, interaction.user.id);
      if (!rows.length) return interaction.reply({ content: "No alerts.", ephemeral: true });

      return interaction.reply({
        content: rows.map(r =>
          `#${r.id} ${r.item_display} ${r.type} ${r.direction} ${formatGold(r.threshold)}`
        ).join("\n"),
        ephemeral: true
      });
    }

    if (sub === "remove") {
      const id = interaction.options.getInteger("id", true);
      const ok = removeAlert(db, interaction.user.id, id);
      return interaction.reply({ content: ok ? "Alert removed." : "Alert not found.", ephemeral: true });
    }
  }

  if (interaction.commandName === "settle") {
    const sub = interaction.options.getSubcommand();

    if (sub === "start") {
      const rolesRaw = interaction.options.getString("roles") ?? "KNIGHT,RP,MS,ED";
      const world = interaction.options.getString("world") ?? "Secura";
      const roles = rolesRaw.split(",").map(s => s.trim()).filter(Boolean);
      if (!roles.length) roles.push("PLAYER1");

      settleSessions.set(interaction.channelId, {
        world,
        roles,
        idx: 0,
        players: []
      });

      return interaction.reply({
        content: `Settlement started for **${world}**.\n**${roles[0]}**: use \`/settle paste\` and paste your analyzer text (must include **Looted Items**).`,
        ephemeral: false
      });
    }

    if (sub === "paste") {
      const sess = settleSessions.get(interaction.channelId);
      if (!sess) return interaction.reply({ content: "No active settlement. Run `/settle start` first.", ephemeral: true });

      const role = sess.roles[sess.idx] ?? `PLAYER${sess.idx + 1}`;
      const text = interaction.options.getString("text", true);

      const parsed = parseAnalyzerText(text);
      if (parsed.supplies == null) {
        return interaction.reply({ content: "Could not parse `Supplies:`. Paste the full analyzer block.", ephemeral: true });
      }

      sess.players.push({
        role,
        discordName: interaction.user.username,
        supplies: parsed.supplies ?? 0,
        loot: parsed.loot ?? null,
        balance: parsed.balance ?? null,
        items: parsed.items ?? []
      });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("settle_add").setLabel("Add another player").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("settle_calc").setLabel("No, calculate now").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("settle_cancel").setLabel("Cancel").setStyle(ButtonStyle.Danger)
      );

      return interaction.reply({
        content: `Captured **${role}** from **${interaction.user.username}**. Item lines: **${parsed.items.length}**.\nDo we need an additional player?`,
        components: [row]
      });
    }
  }
});

/* ------------------ startup ------------------ */

client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
  refreshSnapshotAndTrigger();
  setInterval(refreshSnapshotAndTrigger, 5 * 60 * 1000);
});

client.login(process.env.DISCORD_TOKEN);
