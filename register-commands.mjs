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
      { type: 3, name: "item", description: "Item name", required: true, max_length: 100 }
    ]
  },
  {
    name: "settle",
    description: "Corrected loot (BUY vs NPC BUY) + equal split + direct transfers",
    options: [
      {
        type: 1,
        name: "start",
        description: "Start a settlement session",
        options: [
          { type: 3, name: "world", description: "World (default Secura)", required: false, max_length: 50 }
        ]
      },
      {
        type: 1,
        name: "party",
        description: "Provide Party Hunt Analyzer (text OR attachment .txt)",
        options: [
          {
            type: 3,
            name: "text",
            description: "Paste Party Hunt Analyzer (short) OR leave empty and attach a .txt",
            required: false,
            max_length: 6000
          },
          {
            type: 11,
            name: "file",
            description: "Attach a .txt file with Party Hunt Analyzer (recommended)",
            required: false
          }
        ]
      },
      {
        type: 1,
        name: "looter",
        description: "Provide player's analyzer with Looted Items (text OR attachment .txt)",
        options: [
          { type: 3, name: "name", description: "Exact player name from party analyzer", required: true, max_length: 100 },
          {
            type: 3,
            name: "text",
            description: "Paste player analyzer (short) OR leave empty and attach a .txt",
            required: false,
            max_length: 6000
          },
          {
            type: 11,
            name: "file",
            description: "Attach a .txt file with player analyzer (recommended)",
            required: false
          }
        ]
      },
      {
        type: 1,
        name: "done",
        description: "Compute transfers + sell routes now"
      }
    ]
  }
];

const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);

console.log("Registering slash commands...");
await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
console.log("Done.");
