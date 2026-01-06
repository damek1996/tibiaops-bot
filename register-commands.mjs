import "dotenv/config";
import { REST, Routes, SlashCommandBuilder } from "discord.js";

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;
const guildId = process.env.GUILD_ID;

if (!token || !clientId || !guildId) {
  console.error("Missing env vars: DISCORD_TOKEN, CLIENT_ID, GUILD_ID");
  process.exit(1);
}

const cmd = new SlashCommandBuilder()
  .setName("settle")
  .setDescription("Hunt settlement tools")
  .addSubcommand(sub =>
    sub
      .setName("start")
      .setDescription("Start a settlement session")
      .addStringOption(o =>
        o.setName("world").setDescription("World").setRequired(false)
      )
  )
  .addSubcommand(sub =>
    sub
      .setName("party")
      .setDescription("Paste Party Hunt Analyzer")
      .addStringOption(o =>
        o.setName("text").setDescription("Party analyzer text").setRequired(false)
      )
      .addAttachmentOption(o =>
        o.setName("file").setDescription("Attach .txt with party analyzer").setRequired(false)
      )
  )
  .addSubcommand(sub =>
    sub
      .setName("looter")
      .setDescription("Submit a player's looter log (items)")
      .addStringOption(o =>
        o
          .setName("name")
          .setDescription("Choose character from party list")
          .setRequired(true)
          .setAutocomplete(true)
      )
      .addStringOption(o =>
        o.setName("text").setDescription("Looter analyzer text").setRequired(false)
      )
      .addAttachmentOption(o =>
        o.setName("file").setDescription("Attach .txt with looter analyzer").setRequired(false)
      )
  )
  .addSubcommand(sub =>
    sub
      .setName("done")
      .setDescription("Finish settlement: split + transfers + sell instructions")
  );

const commands = [cmd.toJSON()];

const rest = new REST({ version: "10" }).setToken(token);

console.log("Registering commands...");
await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
console.log("Commands registered.");
