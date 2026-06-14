import { getConfig, saveConfig } from "@/lib/mail/blobs";
import { requireAuth, json } from "@/lib/mail/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  const authError = requireAuth(req);
  if (authError) return authError;

  const updates = await req.json();
  const config = await getConfig();

  if (updates.accounts !== undefined) config.accounts = updates.accounts;
  if (updates.vipSenders !== undefined) config.vipSenders = updates.vipSenders;
  if (updates.categories !== undefined) config.categories = updates.categories;
  if (updates.pollingIntervalMin !== undefined)
    config.pollingIntervalMin = updates.pollingIntervalMin;
  if (updates.notifications !== undefined) {
    const n = config.notifications;
    const u = updates.notifications;
    if (u.telegram) {
      n.telegram.enabled = u.telegram.enabled ?? n.telegram.enabled;
      if (u.telegram.botToken) n.telegram.botToken = u.telegram.botToken;
      if (u.telegram.chatId) n.telegram.chatId = u.telegram.chatId;
    }
    if (u.whatsapp) {
      n.whatsapp.enabled = u.whatsapp.enabled ?? n.whatsapp.enabled;
      if (u.whatsapp.twilioSid) n.whatsapp.twilioSid = u.whatsapp.twilioSid;
      if (u.whatsapp.twilioToken) n.whatsapp.twilioToken = u.whatsapp.twilioToken;
      if (u.whatsapp.userPhone) n.whatsapp.userPhone = u.whatsapp.userPhone;
    }
    if (u.digestTimes) n.digestTimes = u.digestTimes;
    if (u.instantAlertThreshold !== undefined)
      n.instantAlertThreshold = u.instantAlertThreshold;
  }

  await saveConfig(config);
  return json({ ok: true });
}
