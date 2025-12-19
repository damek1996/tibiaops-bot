import "dotenv/config";
import { REST, Routes } from "discord.js";

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID;

if (!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error("Missing env: DISCORD_TOKEN / DISCORD_CLIENT_ID / DISCORD_GUILD_ID");
  process.exit(1);
}

const commands = [
  {
    name: "price",
    description: "Check Secura market price (BUY/SELL) for an item",
    options: [
      { type: 3, name: "item", description: "Item name, e.g. soulbleeder", required: true }
    ]
  },
  {
    name: "settle",
    description: "Party hunt settlement + corrected loot (BUY vs NPC) + transfers",
    options: [
      {
        type: 1,
        name: "start",
        description: "Start a settlement session",
        options: [
          { type: 3, name: "world", description: "World (default Secura)", required: false }
        ]
      },
      {
        type: 1,
        name: "party",
        description: "Paste Party Hunt Analyzer (players + supplies/balances)",
        options: [
          { type: 3, name: "text", description: "Paste Party Hunt Analyzer output", required: true }
        ]
      },
      {
        type: 1,
        name: "looter",
        description: "Paste one player's analyzer (Looted Items)",
        options: [
          { type: 3, name: "name", description: "Exact player name from party analyzer", required: true },
          { type: 3, name: "text", description: "Paste player's analyzer output", required: true }
        ]
      },
      {
        type: 1,
        name: "done",
        description: "Calculate transfers + sell instructions now"
      }
    ]
  }
];

const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);

console.log("Registering slash commands...");
await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
console.log("Done.");
