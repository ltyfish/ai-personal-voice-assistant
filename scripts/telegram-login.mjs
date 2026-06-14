#!/usr/bin/env node
// One-time Telegram user-account login for the voice agent.
//
// Logs into YOUR Telegram account and prints a StringSession to paste into
// .env.local as TELEGRAM_STRING_SESSION. After that, JARVIS can message any of
// your Telegram contacts as you (and import your contact list).
//
// Prereqs (free): create an app at https://my.telegram.org -> API development
// tools, then put the api_id / api_hash in .env.local:
//   TELEGRAM_API_ID="123456"
//   TELEGRAM_API_HASH="abc123..."
//
// Run:  npm run telegram:login

import dotenv from "dotenv";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

dotenv.config({ path: ".env.local" });

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = (process.env.TELEGRAM_API_HASH || "").trim();

if (!apiId || !apiHash) {
  console.error(
    "\n  Set TELEGRAM_API_ID and TELEGRAM_API_HASH in .env.local first.\n" +
      "  Get them free at https://my.telegram.org (API development tools).\n"
  );
  process.exit(1);
}

const rl = readline.createInterface({ input, output });
const ask = (q) => rl.question(q);

console.log("\n  Telegram login — your account, used to send messages as you.\n");

const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
  connectionRetries: 5,
});

await client.start({
  phoneNumber: async () => (await ask("  Phone (with country code, e.g. +65...): ")).trim(),
  password: async () => (await ask("  2FA password (press Enter if none): ")).trim(),
  phoneCode: async () => (await ask("  Code Telegram just sent you: ")).trim(),
  onError: (err) => console.error("  ", err?.message || err),
});

const session = client.session.save();
console.log("\n  ✓ Logged in. Add this line to .env.local:\n");
console.log(`TELEGRAM_STRING_SESSION="${session}"\n`);
console.log("  Then restart the app. Keep this value secret — it's full account access.\n");

await client.disconnect();
rl.close();
process.exit(0);
