import "dotenv/config";
import { REST, Routes } from "discord.js";

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID;

if (!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error("Missing DISCORD_TOKEN, DISCORD_CLIENT_ID, or DISCORD_GUILD_ID in environment.");
  process.exit(1);
}

const commands = [
  {
    name: "price",
    description: "Get Secura market price for an item",
    options: [
      {
        type: 3,
        name: "item",
        description: "Item name, e.g. soulbleeder",
        required: true
      }
    ]
  },
  {
    name: "alert",
    description: "Price alerts",
    options: [
      {
        type: 1,
        name: "add",
        description: "Add an alert",
        options: [
          { type: 3, name: "item", description: "Item name", required: true },
          { type: 3, name: "type", description: "buy or sell", required: true, choices: [{ name: "buy", value: "buy" }, { name: "sell", value: "sell" }] },
          { type: 3, name: "direction", description: "above or below", required: true, choices: [{ name: "above", value: "above" }, { name: "below", value: "below" }] },
          { type: 3, name: "price", description: "e.g. 140kk, 120k, 100000", required: true },
          { type: 5, name: "send_to_channel", description: "Send alert to channel instead of DM", required: false }
        ]
      },
      {
        type: 1,
        name: "list",
        description: "List your alerts"
      },
      {
        type: 1,
        name: "remove",
        description: "Remove an alert",
        options: [{ type: 4, name: "id", description: "Alert ID", required: true }]
      }
    ]
  },
  {
    name: "settle",
    description: "Guided post-hunt settlement (multi-paste)",
    options: [
      {
        type: 1,
        name: "start",
        description: "Start a settlement session",
        options: [
          { type: 3, name: "roles", description: "Comma-separated order, e.g. KNIGHT,RP,MS,ED", required: false },
          { type: 3, name: "world", description: "World (default Secura)", required: false }
        ]
      },
      {
        type: 1,
        name: "paste",
        description: "Paste one player's analyzer text for the current role",
        options: [
          { type: 3, name: "text", description: "Paste analyzer output (including Looted Items)", required: true }
        ]
      }
    ]
  }
];

const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);

try {
  console.log("Registering slash commands...");
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  console.log("Done.");
} catch (e) {
  console.error(e);
  process.exit(1);
}
