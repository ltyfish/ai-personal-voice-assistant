// Outbound messaging for the voice agent — send a message to a person for free
// (no Twilio). Three channels:
//
//   telegram -> server-side via the Bot API (instant, fully hands-free). The
//               recipient must have messaged your bot once so you have their
//               numeric chat id.
//   email    -> Gmail SMTP via nodemailer + an App Password (instant, free).
//   whatsapp -> can't be sent from the server. We return a deep link the local
//               bridge opens in WhatsApp Desktop with the message pre-filled;
//               the bridge can optionally auto-press Enter to send.
//
// Channel resolution lives here so the tool layer stays thin.

import nodemailer from "nodemailer";
import { sendTelegramMessage } from "@/lib/mail/telegram";
import { getConfig } from "@/lib/mail/blobs";
import { findContact, normalizePhone, type Contact } from "@/lib/contacts";
import { isTelegramUserConfigured, sendTelegramAs } from "@/lib/telegram-user";

export type Channel = "whatsapp" | "telegram" | "email";

export type SendResult =
  | { ok: true; channel: Channel; message: string }
  // WhatsApp needs the user's machine — hand an intent back to the browser.
  | { ok: true; channel: "whatsapp"; pendingIntent: WhatsAppIntent; message: string }
  | { ok: false; error: string };

export type WhatsAppIntent = {
  local_action: "whatsapp_send";
  target: string; // whatsapp://send?phone=...&text=...
  label: string; // "WhatsApp to Mom"
  autoSend: boolean; // bridge presses Enter after opening
  pending: true;
};

// ── Telegram ──────────────────────────────────────────────────────────────
async function telegramBotToken(): Promise<string> {
  // Prefer the MailMind config (already used for digest alerts); fall back to env.
  try {
    const cfg = await getConfig();
    const t = cfg.notifications?.telegram?.botToken?.trim();
    if (t) return t;
  } catch {
    /* config unreadable — fall through to env */
  }
  return (process.env.TELEGRAM_BOT_TOKEN || "").trim();
}

async function sendTelegram(handle: string, text: string): Promise<SendResult> {
  const id = handle.trim();
  if (!id) return { ok: false, error: "No Telegram handle for that contact." };

  // Prefer the USER account (GramJS) when configured: it can message anyone you
  // know (@username / phone / id), not just people who started a bot. Fall back
  // to the bot, which needs a numeric chat id of someone who messaged it.
  if (isTelegramUserConfigured()) {
    const r = await sendTelegramAs(id, text);
    return r.ok
      ? { ok: true, channel: "telegram", message: r.message || "Sent on Telegram." }
      : { ok: false, error: r.error || "Telegram send failed." };
  }

  const token = await telegramBotToken();
  if (!token)
    return {
      ok: false,
      error:
        "Telegram isn't set up — log in with `npm run telegram:login`, or add a bot token.",
    };
  if (!/^-?\d+$/.test(id))
    return {
      ok: false,
      error:
        `The bot can only reach a numeric chat id, but “${id}” isn't one. Set up the Telegram user account (npm run telegram:login) to message by @username.`,
    };
  try {
    await sendTelegramMessage(token, id, escapeHtml(text));
    return { ok: true, channel: "telegram", message: "Sent on Telegram." };
  } catch (e: any) {
    return { ok: false, error: `Telegram send failed: ${e?.message || "error"}` };
  }
}

// Telegram parse_mode is HTML in sendTelegramMessage, so escape the body.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ── Email (Gmail SMTP) ──────────────────────────────────────────────────────
function mailer() {
  const user = (process.env.GMAIL_SEND_USER || "").trim();
  const pass = (process.env.GMAIL_APP_PASSWORD || "").replace(/\s+/g, ""); // app
  // passwords are shown in 4-char groups; strip spaces so a pasted one works.
  if (!user || !pass) return null;
  return nodemailer.createTransport({
    service: "gmail",
    auth: { user, pass },
  });
}

async function sendEmail(
  to: string,
  subject: string,
  text: string
): Promise<SendResult> {
  const t = mailer();
  if (!t)
    return {
      ok: false,
      error:
        "Email isn't set up — add GMAIL_SEND_USER and GMAIL_APP_PASSWORD to send mail.",
    };
  const addr = to.trim();
  if (!isEmail(addr)) return { ok: false, error: `“${addr}” isn't a valid email.` };
  try {
    await t.sendMail({
      from: process.env.GMAIL_SEND_USER,
      to: addr,
      subject: subject || "(no subject)",
      text,
    });
    return { ok: true, channel: "email", message: `Emailed ${addr}.` };
  } catch (e: any) {
    return { ok: false, error: `Email send failed: ${e?.message || "error"}` };
  }
}

// ── WhatsApp (deep link for the bridge) ─────────────────────────────────────
function buildWhatsAppIntent(
  phone: string,
  text: string,
  label: string,
  autoSend: boolean
): SendResult {
  // Default the country code (+65) for bare numbers so WhatsApp can resolve them.
  const digits = normalizePhone(phone).replace(/[^\d]/g, "");
  if (!digits)
    return { ok: false, error: `“${phone}” isn't a usable phone number.` };
  // whatsapp:// opens WhatsApp Desktop straight on the chat with the text typed.
  const target = `whatsapp://send?phone=${digits}&text=${encodeURIComponent(text)}`;
  return {
    ok: true,
    channel: "whatsapp",
    pendingIntent: {
      local_action: "whatsapp_send",
      target,
      label,
      autoSend,
      pending: true,
    },
    message: `Ready to message ${label} on WhatsApp.`,
  };
}

// ── Orchestration ───────────────────────────────────────────────────────────
function isEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

// Decide which channel to use when the user didn't say one, given what the
// recipient actually has. WhatsApp first (most reach), then Telegram, then email.
//
// WhatsApp can ONLY be completed through the local bridge (it hands an intent to
// WhatsApp Desktop). When there's no computer connected (mobile/cloud), prefer
// the server-side channels (Telegram, then email) so an auto-pick never lands on
// a WhatsApp intent the phone can't fulfil; fall back to WhatsApp only if it's
// the recipient's sole handle.
function pickChannel(
  c: { phone?: string; telegram?: string; email?: string },
  bridgeAvailable: boolean
): Channel | null {
  if (bridgeAvailable) {
    if (c.phone) return "whatsapp";
    if (c.telegram) return "telegram";
    if (c.email) return "email";
    return null;
  }
  if (c.telegram) return "telegram";
  if (c.email) return "email";
  if (c.phone) return "whatsapp"; // last resort — will report it needs the computer
  return null;
}

const WHATSAPP_NEEDS_COMPUTER =
  "WhatsApp needs your computer connected (it opens WhatsApp Desktop) — try Telegram or email, or send it from your laptop.";

// Infer the channel from a RAW handle when there's no saved contact.
function inferChannelFromHandle(handle: string): Channel | null {
  const h = handle.trim();
  if (isEmail(h)) return "email";
  if (h.startsWith("@")) return "telegram";
  if (/^\+?[\d][\d\s().-]{4,}$/.test(h)) return "whatsapp"; // looks like a number
  return null;
}

export type SendOptions = {
  to: string; // contact name OR a raw handle (number / @user / email)
  channel?: Channel | null; // explicit channel, else auto
  message: string;
  subject?: string | null; // email only
  autoSendWhatsApp?: boolean; // bridge presses Enter (from user preference)
  // False when no computer is connected (mobile/cloud): WhatsApp can't be
  // fulfilled, so auto-pick avoids it and an explicit WhatsApp ask is refused.
  bridgeAvailable?: boolean;
};

// Resolve recipient + channel and dispatch. Returns a SendResult the tool layer
// passes straight back (WhatsApp results carry a pendingIntent for the browser).
export async function sendMessage(opts: SendOptions): Promise<SendResult> {
  const body = (opts.message || "").trim();
  if (!body) return { ok: false, error: "There's no message to send." };
  const who = (opts.to || "").trim();
  if (!who) return { ok: false, error: "Who should I send it to?" };

  const bridgeAvailable = opts.bridgeAvailable ?? true;
  const contact = await findContact(who);
  let channel: Channel | null = opts.channel ?? null;
  let label = contact?.name || who;

  // The user explicitly asked for WhatsApp but there's no computer to run it.
  if (channel === "whatsapp" && !bridgeAvailable)
    return { ok: false, error: WHATSAPP_NEEDS_COMPUTER };

  // Resolve the destination handle for the chosen (or auto) channel.
  let phone: string | undefined;
  let telegram: string | undefined;
  let email: string | undefined;

  if (contact) {
    phone = contact.phone;
    telegram = contact.telegram;
    email = contact.email;
    if (!channel) channel = pickChannel(contact, bridgeAvailable);
    if (!channel)
      return {
        ok: false,
        error: `${contact.name} has no phone, Telegram, or email saved. Add one first.`,
      };
    // Auto-pick only fell back to WhatsApp (their sole handle) but no computer
    // is connected to run it — say so instead of returning a dead intent.
    if (channel === "whatsapp" && !bridgeAvailable)
      return { ok: false, error: WHATSAPP_NEEDS_COMPUTER };
  } else {
    // Raw handle — infer the channel if not given, then slot the handle in.
    if (!channel) channel = inferChannelFromHandle(who);
    if (!channel)
      return {
        ok: false,
        error: `I don't have a contact called “${who}”, and I can't tell how to reach that. Try a number, @username, or email.`,
      };
    if (channel === "whatsapp" && !bridgeAvailable)
      return { ok: false, error: WHATSAPP_NEEDS_COMPUTER };
    if (channel === "whatsapp") phone = who;
    else if (channel === "telegram") telegram = who;
    else if (channel === "email") email = who;
    label = who;
  }

  switch (channel) {
    case "telegram":
      if (!telegram)
        return { ok: false, error: `No Telegram handle for ${label}.` };
      return sendTelegram(telegram, body);
    case "email":
      if (!email) return { ok: false, error: `No email for ${label}.` };
      return sendEmail(email, (opts.subject || "").trim(), body);
    case "whatsapp":
      if (!phone) return { ok: false, error: `No phone number for ${label}.` };
      return buildWhatsAppIntent(
        phone,
        body,
        `WhatsApp to ${label}`,
        opts.autoSendWhatsApp ?? false
      );
    default:
      return { ok: false, error: "I couldn't pick a way to send that." };
  }
}
