import { getConfig } from "@/lib/mail/blobs";
import { sendTelegramMessage } from "@/lib/mail/telegram";
import { sendWhatsAppMessage } from "@/lib/mail/whatsapp";
import { requireAuth, json } from "@/lib/mail/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  const authError = requireAuth(req);
  if (authError) return authError;

  const { channel } = await req.json();
  const config = await getConfig();
  const testMsg = "✅ Email Summarizer test notification — everything is connected!";
  const results: Record<string, string> = {};

  if (channel === "telegram" || channel === "all") {
    const { telegram } = config.notifications;
    if (!telegram.enabled || !telegram.botToken || !telegram.chatId) {
      results.telegram = "not configured";
    } else {
      try {
        await sendTelegramMessage(telegram.botToken, telegram.chatId, testMsg);
        results.telegram = "sent";
      } catch (e) {
        results.telegram = `error: ${(e as Error).message}`;
      }
    }
  }

  if (channel === "whatsapp" || channel === "all") {
    const { whatsapp } = config.notifications;
    if (!whatsapp.enabled || !whatsapp.userPhone) {
      results.whatsapp = "not configured";
    } else {
      try {
        await sendWhatsAppMessage(
          whatsapp.twilioSid,
          whatsapp.twilioToken,
          process.env.TWILIO_WHATSAPP_FROM,
          whatsapp.userPhone,
          testMsg
        );
        results.whatsapp = "sent";
      } catch (e) {
        results.whatsapp = `error: ${(e as Error).message}`;
      }
    }
  }

  return json(results);
}
