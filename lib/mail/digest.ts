// Daily digest. Ported from netlify/functions/daily-digest.js.
import { getConfig, listSummaries, addGroqUsage, getDigestState, saveDigestState } from "./blobs";
import { synthesizeCategorySummary } from "./groq";
import { sendTelegramMessage, formatDigestMessage, type DigestBlock } from "./telegram";
import type { Summary } from "./types";

const SGT_OFFSET = 8 * 3600 * 1000;

function parseDigestMinute(value: string): number | null {
  const m = String(value || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }
  return hour * 60 + minute;
}

function digestDueNow(nowSGT: Date, digestTimes: string[], pollingIntervalMin: number) {
  const nowMinute = nowSGT.getUTCHours() * 60 + nowSGT.getUTCMinutes();
  const windowMin = Math.max(1, Math.min(60, Math.round(pollingIntervalMin || 10)));
  for (const time of digestTimes) {
    const target = parseDigestMinute(time);
    if (target == null) continue;
    const elapsed = nowMinute - target;
    if (elapsed >= 0 && elapsed < windowMin) return { due: true, time };
  }
  return { due: false, time: null as string | null };
}

// Build category blocks: one synthesized summary per category, urgent flag,
// and a gmail link to the most urgent email in the category.
async function buildCategoryBlocks(summaries: Summary[]): Promise<DigestBlock[]> {
  const byCategory: Record<string, Summary[]> = {};
  for (const s of summaries) {
    const cat = s.category || "Other";
    (byCategory[cat] ??= []).push(s);
  }

  const blocks: DigestBlock[] = [];
  for (const [category, items] of Object.entries(byCategory)) {
    const hasUrgent = items.some((s) => s.urgency >= 4);
    let summaryText: string;
    try {
      const { text, usage, model, limits } = await synthesizeCategorySummary(
        category,
        items
      );
      summaryText = text;
      await addGroqUsage(usage, { model, limits }).catch(() => {});
    } catch (err) {
      console.error(
        `Category synthesis failed for ${category}:`,
        (err as Error).message
      );
      summaryText = items.map((s) => s.subject).slice(0, 3).join("; ");
    }
    // Link to the most urgent email in the category (highest urgency, newest)
    const lead = [...items].sort(
      (a, b) => b.urgency - a.urgency || b.receivedAt.localeCompare(a.receivedAt)
    )[0];
    blocks.push({
      category,
      count: items.length,
      hasUrgent,
      summaryText,
      gmailLink: lead.gmailLink,
    });
  }
  // Categories with urgent emails first, then by count descending
  blocks.sort(
    (a, b) => Number(b.hasUrgent) - Number(a.hasUrgent) || b.count - a.count
  );
  return blocks;
}

// Core digest logic. When `force` is true the time-of-day check is skipped.
export async function runDigest({ force = false }: { force?: boolean } = {}) {
  const config = await getConfig();
  const { notifications } = config;

  const nowSGT = new Date(Date.now() + SGT_OFFSET);
  const todaySGT = nowSGT.toISOString().slice(0, 10);
  let sentKey = "";

  if (!force) {
    const due = digestDueNow(nowSGT, notifications.digestTimes, config.pollingIntervalMin);
    if (!due.due || !due.time) {
      console.log(
        `Skipping digest — SGT time ${nowSGT.toISOString().slice(11, 16)} not in digestTimes:`,
        notifications.digestTimes
      );
      return { sent: false, reason: "not-digest-time" };
    }
    sentKey = `${todaySGT}:${due.time}`;
    const state = await getDigestState();
    if (state.sent[sentKey]) {
      return { sent: false, reason: "already-sent", sentKey, sentAt: state.sent[sentKey] };
    }
  }

  // "Yesterday + overnight": from yesterday 00:00 SGT through now.
  const startSGT = Date.UTC(
    nowSGT.getUTCFullYear(),
    nowSGT.getUTCMonth(),
    nowSGT.getUTCDate() - 1
  );
  const startUTC = startSGT - SGT_OFFSET; // yesterday 00:00 SGT in real UTC ms
  const endUTC = Date.now();

  // Summaries are keyed by UTC date; this window straddles up to 3 UTC buckets.
  const buckets = new Set<string>();
  for (let t = startUTC; t <= endUTC; t += 24 * 3600 * 1000) {
    buckets.add(new Date(t).toISOString().slice(0, 10));
  }
  buckets.add(new Date(endUTC).toISOString().slice(0, 10));
  const collected = (
    await Promise.all([...buckets].map((date) => listSummaries({ date })))
  ).flat();
  const summaries = collected.filter((s) => {
    const t = new Date(s.receivedAt).getTime();
    return t >= startUTC && t <= endUTC;
  });

  const digestLabel = new Date(startUTC + SGT_OFFSET).toISOString().slice(0, 10);

  if (!summaries.length) {
    console.log(`No summaries for window starting SGT ${digestLabel}, skipping digest`);
    return { sent: false, reason: "no-summaries", digestLabel };
  }

  const blocks = await buildCategoryBlocks(summaries);
  const meta = {
    total: summaries.length,
    unread: summaries.filter((s) => !s.reviewed).length,
  };

  const { telegram } = notifications;
  const channels: string[] = [];

  if (telegram.enabled && telegram.botToken && telegram.chatId) {
    const msg = formatDigestMessage(digestLabel, blocks, meta);
    await sendTelegramMessage(telegram.botToken, telegram.chatId, msg).catch(
      console.error
    );
    channels.push("telegram");
  }

  if (sentKey) {
    const state = await getDigestState();
    state.sent[sentKey] = new Date().toISOString();
    const keep = Object.entries(state.sent)
      .sort((a, b) => b[1].localeCompare(a[1]))
      .slice(0, 60);
    await saveDigestState({ sent: Object.fromEntries(keep) });
  }

  return {
    sent: true,
    digestLabel,
    count: summaries.length,
    categories: blocks.length,
    channels,
  };
}
