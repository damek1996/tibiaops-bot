import "dotenv/config";
import { Client, GatewayIntentBits } from "discord.js";
import {
  initDb,
  addAlert,
  listAlerts,
  removeAlert,
  getAllAlerts
} from "./db.js";

import {
  fetchMarketSnapshotSecura,
  normItemName,
  parseGold,
  formatGold
} from "./provider.js";

const db = initDb();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages]
});

let lastSnapshot = { updatedAt: null, items: new Map() };

/* ------------------ market refresh ------------------ */

async function refreshSnapshotAndTrigger() {
  try {
    const alerts = getAllAlerts(db);
    const uniqueItems = [...new Set(alerts.map(a => a.item_display))];

    if (!uniqueItems.length) return;

    const snap = await fetchMarketSnapshotSecura(uniqueItems);
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
        `🔔 **Market Alert — Secura**\n` +
        `**${a.item_display}** ${a.type} price is **${formatGold(price)}**\n` +
        `Rule: ${a.type} ${a.direction} ${formatGold(a.threshold)}\n` +
        `Updated: ${lastSnapshot.updatedAt.toISOString()}`;

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
        `Buy: ${data.buy ? formatGold(data.buy) : "n/a"}\n` +
        `Sell: ${data.sell ? formatGold(data.sell) : "n/a"}\n` +
        `Updated: ${lastSnapshot.updatedAt.toISOString()}`,
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
        return interaction.reply({ content: "Invalid price.", ephemeral: true });
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

      return interaction.reply({
        content: `Alert added for **${item}**.`,
        ephemeral: true
      });
    }

    if (sub === "list") {
      const rows = listAlerts(db, interaction.user.id);
      if (!rows.length) {
        return interaction.reply({ content: "No alerts.", ephemeral: true });
      }

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
      return interaction.reply({
        content: ok ? "Alert removed." : "Alert not found.",
        ephemeral: true
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
