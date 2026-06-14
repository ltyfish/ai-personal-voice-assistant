import type { Summary } from "./types";

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

function shortDate(d: string) {
  const date = new Date(d);
  if (isNaN(date.getTime())) return d;
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export async function sendTelegramMessage(botToken: string, chatId: string, text: string) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Telegram error: ${err}`);
  }
  return res.json();
}

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

export function formatInstantAlert(summary: Summary) {
  const fromName =
    summary.from.replace(/<.*>/, "").replace(/"/g, "").trim() ||
    summary.from.split("@")[0];
  const u = summary.urgency;
  const actions = summary.actionItems?.length
    ? `\n\n${summary.actionItems.slice(0, 3).map((a) => `▸ ${a}`).join("\n")}`
    : "";
  const deadline = summary.deadlineMentioned
    ? `\n\n⏰ <b>${formatDeadline(summary.deadlineMentioned)}</b>`
    : "";

  return `${U_EMOJI[u]} <b>${U_LABEL[u].toUpperCase()}</b>  ·  ${summary.account}

<b>${summary.subject}</b>
<i>${fromName}</i>

${summary.summary}${actions}${deadline}

<a href="${summary.gmailLink}">open gmail</a>  ·  <a href="${SITE}">dashboard</a>`;
}

export type DigestBlock = {
  category: string;
  count: number;
  hasUrgent: boolean;
  summaryText: string;
  gmailLink?: string;
};

export function formatDigestMessage(
  date: string,
  blocks: DigestBlock[],
  meta: { total: number; unread: number }
) {
  let msg = `📬 <b>${shortDate(date)}</b> · ${meta.total} email${
    meta.total !== 1 ? "s" : ""
  }`;
  if (meta.unread) msg += ` · ${meta.unread} unread`;
  msg += `\n`;

  blocks.forEach((b) => {
    const urgentTag = b.hasUrgent ? " 🔴 <b>urgent</b>" : "";
    msg += `\n${catEmoji(b.category)} <b>${b.category} (${b.count})</b>${urgentTag}\n`;
    msg += `${b.summaryText}\n`;
    msg += `<a href="${b.gmailLink}">📧 open gmail</a>  ·  <a href="${SITE}">🌐 dashboard</a>\n`;
  });

  return msg.trimEnd();
}
