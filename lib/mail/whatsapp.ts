import twilio from "twilio";
import type { Summary } from "./types";
import type { DigestBlock } from "./telegram";

const SITE = process.env.SITE_URL ?? "";
const U_EMOJI = ["", "⚪", "🔵", "🟡", "🟠", "🔴"];
const U_LABEL = ["", "Minimal", "Low", "Medium", "High", "Critical"];

const CAT_EMOJI: Record<string, string> = {
  Work: "💼",
  School: "🎓",
  Finance: "💰",
  Personal: "🙂",
  Newsletters: "📰",
  Promotions: "🏷️",
};
const catEmoji = (c: string) => CAT_EMOJI[c] ?? "📩";

function formatDeadline(d: string) {
  const date = new Date(d);
  if (isNaN(date.getTime())) return d;
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function shortDate(d: string) {
  const date = new Date(d);
  if (isNaN(date.getTime())) return d;
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export async function sendWhatsAppMessage(
  accountSid: string,
  authToken: string,
  from: string | undefined,
  to: string,
  body: string
) {
  const client = twilio(accountSid, authToken);
  return client.messages.create({
    from: `whatsapp:${from}`,
    to: `whatsapp:${to}`,
    body,
  });
}

export function formatInstantAlertPlain(summary: Summary) {
  const fromName =
    summary.from.replace(/<.*>/, "").replace(/"/g, "").trim() ||
    summary.from.split("@")[0];
  const u = summary.urgency;
  const actions = summary.actionItems?.length
    ? `\n\n${summary.actionItems.slice(0, 3).map((a) => `▸ ${a}`).join("\n")}`
    : "";
  const deadline = summary.deadlineMentioned
    ? `\n\n⏰ *${formatDeadline(summary.deadlineMentioned)}*`
    : "";

  return `${U_EMOJI[u]} *${U_LABEL[u].toUpperCase()}*  ·  ${summary.account}

*${summary.subject}*
*${fromName}*

${summary.summary}${actions}${deadline}

${summary.gmailLink}

${SITE}`;
}

export function formatDigestPlainText(
  date: string,
  blocks: DigestBlock[],
  meta: { total: number; unread: number }
) {
  let msg = `📬 *${shortDate(date)}* · ${meta.total} email${
    meta.total !== 1 ? "s" : ""
  }`;
  if (meta.unread) msg += ` · ${meta.unread} unread`;
  msg += `\n`;

  blocks.forEach((b) => {
    const urgentTag = b.hasUrgent ? " 🔴 *urgent*" : "";
    msg += `\n${catEmoji(b.category)} *${b.category} (${b.count})*${urgentTag}\n`;
    msg += `${b.summaryText}\n`;
    msg += `📧 ${b.gmailLink}\n🌐 ${SITE}\n`;
  });

  return msg.trimEnd();
}
