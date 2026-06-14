// Telegram via YOUR user account (GramJS / MTProto), not a bot.
//
// Unlike the bot (which can only message people who started it), a user session
// can message anyone you could message in the Telegram app, and can read your
// contact list. Set up once with scripts/telegram-login.mjs, which prints a
// StringSession to store in TELEGRAM_STRING_SESSION (plus TELEGRAM_API_ID /
// TELEGRAM_API_HASH from https://my.telegram.org).
//
// GramJS is a heavy, Node-only dependency, so it's dynamically imported inside
// each function — it never loads unless a Telegram-user action actually runs.

import { upsertContact } from "@/lib/contacts";

export function isTelegramUserConfigured(): boolean {
  return !!(
    process.env.TELEGRAM_API_ID &&
    process.env.TELEGRAM_API_HASH &&
    process.env.TELEGRAM_STRING_SESSION
  );
}

// Reuse ONE connected client across calls. Connecting an MTProto session costs
// several seconds, which is the bulk of the "still thinking" delay after a send,
// so we keep the socket warm instead of connect→disconnect every time. The
// session is fully resumable, so a dropped socket just reconnects on next use.
let cachedClient: any = null;

async function getClient(): Promise<any> {
  const apiId = Number(process.env.TELEGRAM_API_ID);
  const apiHash = (process.env.TELEGRAM_API_HASH || "").trim();
  const session = (process.env.TELEGRAM_STRING_SESSION || "").trim();
  if (!apiId || !apiHash || !session)
    throw new Error("Telegram user account isn't configured.");

  if (cachedClient?.connected) return cachedClient;

  const { TelegramClient } = await import("telegram");
  const { StringSession } = await import("telegram/sessions");
  const client = new TelegramClient(new StringSession(session), apiId, apiHash, {
    connectionRetries: 3,
  });
  await client.connect();
  cachedClient = client;
  return client;
}

async function withClient<T>(fn: (client: any) => Promise<T>): Promise<T> {
  let client = await getClient();
  try {
    return await fn(client);
  } catch (e: any) {
    // If the cached socket went stale, drop it and retry once on a fresh one.
    if (/disconnect|not connected|closed|timeout/i.test(e?.message || "")) {
      cachedClient = null;
      client = await getClient();
      return await fn(client);
    }
    throw e;
  }
}

export type TgResult = { ok: boolean; message?: string; error?: string };

// Send a message AS the user to a handle: "@username", a phone number, or a
// numeric user id (resolvable when the person is in your contacts/dialogs).
export async function sendTelegramAs(
  target: string,
  message: string
): Promise<TgResult> {
  const handle = (target || "").trim();
  if (!handle) return { ok: false, error: "No Telegram handle." };
  try {
    return await withClient(async (client) => {
      const entity = await client.getEntity(handle);
      await client.sendMessage(entity, { message });
      return { ok: true, message: "Sent on Telegram." };
    });
  } catch (e: any) {
    return { ok: false, error: `Telegram send failed: ${e?.message || "error"}` };
  }
}

export type TgImportResult = {
  ok: boolean;
  imported: number;
  skipped: number;
  error?: string;
};

// Import your Telegram contacts (name → @username or phone) into the book.
export async function importTelegramContacts(): Promise<TgImportResult> {
  try {
    return await withClient(async (client) => {
      const { Api } = await import("telegram");
      const bigInt = (await import("big-integer")).default;
      const result: any = await client.invoke(
        new Api.contacts.GetContacts({ hash: bigInt(0) })
      );
      const users: any[] = result.users ?? [];
      let imported = 0;
      let skipped = 0;
      for (const u of users) {
        const name = [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
        // Prefer a username (most stable to resolve later); else the phone.
        const handle = u.username
          ? `@${u.username}`
          : u.phone
          ? `+${String(u.phone).replace(/^\+/, "")}`
          : null;
        if (!name || !handle) {
          skipped++;
          continue;
        }
        await upsertContact({ name, telegram: handle });
        imported++;
      }
      return { ok: true, imported, skipped };
    });
  } catch (e: any) {
    return { ok: false, imported: 0, skipped: 0, error: e?.message || "error" };
  }
}
