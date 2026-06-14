import { getConfig, listSummaries } from "@/lib/mail/blobs";
import { sendWhatsAppMessage } from "@/lib/mail/whatsapp";
import type { Summary } from "@/lib/mail/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SITE = process.env.SITE_URL ?? "";
const SGT_OFFSET = 8 * 3600 * 1000;

// Keep only summaries received during today's SGT calendar day.
function todayOnly(summaries: Summary[]) {
  const nowSGT = new Date(Date.now() + SGT_OFFSET);
  const startUTC =
    Date.UTC(nowSGT.getUTCFullYear(), nowSGT.getUTCMonth(), nowSGT.getUTCDate()) -
    SGT_OFFSET;
  const endUTC = startUTC + 24 * 3600 * 1000;
  return summaries.filter((s) => {
    const t = new Date(s.receivedAt).getTime();
    return t >= startUTC && t < endUTC;
  });
}

const HELP = `Commands:
summary — today's email summaries
urgent — urgent emails (High + Critical)
help — show this message`;

export async function POST(req: Request) {
  let params: Record<string, string>;
  try {
    const text = await req.text();
    params = Object.fromEntries(new URLSearchParams(text));
  } catch {
    return new Response("ok");
  }

  const incomingBody = (params.Body ?? "").toLowerCase().trim();
  const from = params.From ?? "";

  const config = await getConfig();
  const { twilioSid, twilioToken, userPhone } = config.notifications.whatsapp;
  const fromEnv = process.env.TWILIO_WHATSAPP_FROM;

  if (!twilioSid || !twilioToken || !userPhone) return new Response("ok");

  const expectedFrom = `whatsapp:${userPhone}`;
  if (from !== expectedFrom) return new Response("ok");

  const today = new Date().toISOString().slice(0, 10);

  const reply = async (msg: string) => {
    await sendWhatsAppMessage(twilioSid, twilioToken, fromEnv, userPhone, msg);
  };

  try {
    if (incomingBody === "summary") {
      const summaries = await listSummaries({ date: today });
      if (!summaries.length) {
        await reply(`📭 No emails summarized for today yet.`);
      } else {
        const header = `📬 ${shortDate(today)} · ${summaries.length} email${
          summaries.length !== 1 ? "s" : ""
        }`;
        const lines = summaries.slice(0, 8).map((s) => {
          const sender =
            s.from.replace(/<.*>/, "").replace(/"/g, "").trim() ||
            s.from.split("@")[0];
          return `${urgencyEmoji(s.urgency)} *${truncate(
            s.subject,
            45
          )}*\n\n*${sender}* · ${truncate(s.summary, 70)}`;
        });
        const footer =
          summaries.length > 8 ? `\n+${summaries.length - 8} more on dashboard` : "";
        await reply(`${header}\n\n\n${lines.join("\n\n")}${footer}`);
      }
    } else if (incomingBody === "urgent") {
      const summaries = todayOnly(await listSummaries({ urgency: "4" }));
      if (!summaries.length) {
        await reply("✅ No urgent emails today.");
      } else {
        const lines = summaries.slice(0, 5).map((s) => {
          const sender =
            s.from.replace(/<.*>/, "").replace(/"/g, "").trim() ||
            s.from.split("@")[0];
          return `${urgencyEmoji(s.urgency)} *${truncate(
            s.subject,
            45
          )}*\n\n*${sender}* · ${truncate(s.summary, 70)}\n📧 ${s.gmailLink}`;
        });
        await reply(`🚨 *Urgent today*\n\n${lines.join("\n\n")}\n\n🌐 ${SITE}`);
      }
    } else {
      await reply(HELP);
    }
  } catch (err) {
    console.error("whatsapp-webhook error:", (err as Error).message);
  }

  return new Response("ok");
}

function urgencyEmoji(u: number) {
  return ["", "⚪", "🔵", "🟡", "🟠", "🔴"][u] ?? "⚪";
}

function truncate(str: string, len: number) {
  return str.length > len ? str.slice(0, len - 1) + "…" : str;
}

function shortDate(isoDate: string) {
  const [y, m, d] = isoDate.split("-");
  return new Date(Date.UTC(Number(y), Number(m) - 1, Number(d))).toLocaleDateString(
    "en-US",
    { month: "short", day: "numeric", timeZone: "UTC" }
  );
}
