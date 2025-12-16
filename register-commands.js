import "dotenv/config";
import { REST, Routes, SlashCommandBuilder } from "discord.js";

const commands = [
  new SlashCommandBuilder()
    .setName("alert")
    .setDescription("Manage Tibia market alerts (Secura)")
    .addSubcommand(sub =>
      sub
        .setName("add")
        .setDescription("Add a market alert")
        .addStringOption(o =>
          o.setName("item").setDescription("Item name").setRequired(true)
        )
        .addStringOption(o =>
          o.setName("type")
            .setDescription("Buy or sell")
            .setRequired(true)
            .addChoices(
              { name: "buy", value: "buy" },
              { name: "sell", value: "sell" }
            )
        )
        .addStringOption(o =>
          o.setName("direction")
            .setDescription("Price condition")
            .setRequired(true)
            .addChoices(
              { name: "below", value: "below" },
              { name: "above", value: "above" }
            )
        )
        .addStringOption(o =>
          o.setName("price")
            .setDescription("Example: 9kk, 9000000")
            .setRequired(true)
        )
        .addBooleanOption(o =>
          o.setName("send_to_channel")
            .setDescription("Send alert to this channel")
            .setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub.setName("list").setDescription("List your alerts")
    )
    .addSubcommand(sub =>
      sub
        .setName("remove")
        .setDescription("Remove an alert")
        .addIntegerOption(o =>
          o.setName("id").setDescription("Alert ID").setRequired(true)
        )
    ),

  new SlashCommandBuilder()
    .setName("price")
    .setDescription("Check latest market price (Secura)")
    .addStringOption(o =>
      o.setName("item").setDescription("Item name").setRequired(true)
    )
].map(c => c.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

async function main() {
  await rest.put(
    Routes.applicationGuildCommands(
      process.env.DISCORD_CLIENT_ID,
      process.env.DISCORD_GUILD_ID
    ),
    { body: commands }
  );
  console.log("Registered guild commands.");
}

main().catch(console.error);
