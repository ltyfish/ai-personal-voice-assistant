import { getConfig, listSummaries } from "@/lib/mail/blobs";
import { sendTelegramMessage } from "@/lib/mail/telegram";
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
/summary — today's email summaries
/urgent — urgent emails (High + Critical)
/help — show this message`;

export async function POST(req: Request) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response("ok");
  }

  const message = body.message;
  if (!message?.text) return new Response("ok");

  const text = message.text.toLowerCase().trim();
  const chatId = String(message.chat.id);

  const config = await getConfig();
  const { botToken, chatId: allowedChatId } = config.notifications.telegram;

  if (!botToken || chatId !== String(allowedChatId)) return new Response("ok");

  const today = new Date().toISOString().slice(0, 10);

  try {
    if (text === "/summary" || text === "/summary@" + message.text.split("@")[1]) {
      const summaries = await listSummaries({ date: today });
      if (!summaries.length) {
        await sendTelegramMessage(
          botToken,
          chatId,
          `📭 No emails summarized for today yet.`
        );
      } else {
        const header = `📬 <b>${shortDate(today)} · ${summaries.length} email${
          summaries.length !== 1 ? "s" : ""
        }</b>`;
        const lines = summaries.slice(0, 10).map((s) => {
          const sender =
            s.from.replace(/<.*>/, "").replace(/"/g, "").trim() ||
            s.from.split("@")[0];
          return `${urgencyEmoji(s.urgency)} <b>${truncate(
            s.subject,
            45
          )}</b>\n\n<b>${sender}</b> · ${truncate(s.summary, 70)}`;
        });
        const footer =
          summaries.length > 10 ? `\n+${summaries.length - 10} more on dashboard` : "";
        await sendTelegramMessage(
          botToken,
          chatId,
          `${header}\n\n\n${lines.join("\n\n")}${footer}`
        );
      }
    } else if (text === "/urgent") {
      const summaries = todayOnly(await listSummaries({ urgency: "4" }));
      if (!summaries.length) {
        await sendTelegramMessage(botToken, chatId, "✅ No urgent emails today.");
      } else {
        const lines = summaries.slice(0, 5).map((s) => {
          const sender =
            s.from.replace(/<.*>/, "").replace(/"/g, "").trim() ||
            s.from.split("@")[0];
          return `${urgencyEmoji(s.urgency)} <b>${truncate(
            s.subject,
            45
          )}</b>\n\n<b>${sender}</b> · ${truncate(
            s.summary,
            70
          )}\n<a href="${s.gmailLink}">📧 open gmail</a>`;
        });
        await sendTelegramMessage(
          botToken,
          chatId,
          `🚨 <b>Urgent today</b>\n\n${lines.join(
            "\n\n"
          )}\n\n<a href="${SITE}">🌐 dashboard →</a>`
        );
      }
    } else {
      await sendTelegramMessage(botToken, chatId, HELP);
    }
  } catch (err) {
    console.error("telegram-webhook error:", (err as Error).message);
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
