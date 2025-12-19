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
