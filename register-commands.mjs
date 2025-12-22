import "dotenv/config";
import { REST, Routes } from "discord.js";

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;

if (!token) throw new Error("Missing DISCORD_TOKEN in .env");
if (!clientId) throw new Error("Missing DISCORD_CLIENT_ID in .env");

const commands = [
  {
    name: "price",
    description: "Check Secura market BUY offer vs NPC buy for an item",
    options: [
      {
        type: 3,
        name: "item",
        description: "Item name (e.g. soulbleeder, gold coin)",
        required: true
      }
    ]
  },
  {
    name: "settle",
    description: "Hunt settlement tools",
    options: [
      {
        type: 1,
        name: "start",
        description: "Start a settlement session",
        options: [
          {
            type: 3,
            name: "world",
            description: "Tibia world (default: Secura)",
            required: false
          }
        ]
      },
      {
        type: 1,
        name: "party",
        description: "Paste Party Hunt Analyzer",
        options: [
          { type: 3, name: "text", description: "Paste analyzer text", required: false },
          { type: 11, name: "file", description: "Attach .txt with analyzer", required: false }
        ]
      },
      {
        type: 1,
        name: "looter",
        description: "Submit a player's looted items analyzer (use dropdown if no name)",
        options: [
          {
            type: 3,
            name: "name",
            description: "Optional exact party name (recommended: leave empty and use dropdown)",
            required: false
          },
          { type: 3, name: "text", description: "Paste analyzer text", required: false },
          { type: 11, name: "file", description: "Attach .txt with analyzer", required: false }
        ]
      },
      {
        type: 1,
        name: "done",
        description: "Compute equal split + transfers + sell instructions"
      }
    ]
  }
];

const rest = new REST({ version: "10" }).setToken(token);

try {
  console.log("Registering slash commands...");
  await rest.put(Routes.applicationCommands(clientId), { body: commands });
  console.log("Slash commands registered successfully.");
} catch (err) {
  console.error(err);
  process.exit(1);
}
