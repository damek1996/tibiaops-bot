import "dotenv/config";
import { REST, Routes } from "discord.js";

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const guildId = process.env.DISCORD_GUILD_ID;

if (!token) throw new Error("Missing DISCORD_TOKEN in .env");
if (!clientId) throw new Error("Missing DISCORD_CLIENT_ID in .env");
if (!guildId) throw new Error("Missing DISCORD_GUILD_ID in .env");

const commands = [
  {
    name: "split_party",
    description: "Start a split session by pasting Party Hunt Analyzer",
    options: [
      {
        type: 3,
        name: "text",
        description: "Paste party analyzer text",
        required: false
      },
      {
        type: 11,
        name: "file",
        description: "Attach a .txt file with party analyzer text",
        required: false
      }
    ]
  },
  {
    name: "split_looter",
    description: "Submit a player looter analyzer (items) for the current party",
    options: [
      {
        type: 3,
        name: "name",
        description: "Character name from party roster",
        required: true,
        autocomplete: true
      },
      {
        type: 11,
        name: "file",
        description: "Attach a .txt file with looter analyzer text",
        required: true
      }
    ]
  },
  {
    name: "split_done",
    description: "Finish settlement and show transfers + sell instructions"
  },
  {
    name: "price",
    description: "Check price for an item (Secura)",
    options: [
      {
        type: 3,
        name: "item",
        description: "Item name",
        required: true
      }
    ]
  }
];

const rest = new REST({ version: "10" }).setToken(token);

console.log("Registering guild commands...");
await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
console.log("Done.");
