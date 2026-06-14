// Core email polling + summarization. Ported from netlify/functions/fetch-emails.js.
// Exposed as runFetch() so both the cron route and manual-fetch can call it.
import {
  getConfig,
  getPollState,
  savePollState,
  saveSummary,
  hasSummary,
  addGroqUsage,
  localDateKey,
} from "./blobs";
import { fetchNewEmails, buildGmailLink, type RawEmail } from "./gmail";
import { summarizeEmails } from "./groq";
import { applyVipBoost } from "./urgency";
import { sendTelegramMessage, formatInstantAlert } from "./telegram";
import type { MailConfig, Summary } from "./types";

export async function runFetch(): Promise<{
  ok: boolean;
  error?: string;
  newCount: number;
  newSummaries: Summary[];
}> {
  const config = await getConfig();
  const pollState = await getPollState();

  if (!config.accounts.length) {
    console.log("No accounts configured, skipping poll");
    return { ok: true, newCount: 0, newSummaries: [] };
  }

  const allNewEmails: RawEmail[] = [];

  for (const account of config.accounts) {
    const lastPoll =
      pollState.accounts[account.label]?.lastPoll ??
      new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    try {
      const emails = await fetchNewEmails(account.refreshToken!, lastPoll);
      allNewEmails.push(
        ...emails.map((e) => ({
          ...e,
          account: account.label,
          accountEmail: account.email,
        }))
      );
      pollState.accounts[account.label] = { lastPoll: new Date().toISOString() };
    } catch (err) {
      console.error(
        `Failed to fetch emails for ${account.label}:`,
        (err as Error).message
      );
    }
  }

  await savePollState(pollState);

  // Skip emails already summarized (prevents re-alerts on manual Fetch Now)
  const newOnly = await Promise.all(
    allNewEmails.map(async (e) => {
      // Same LOCAL-date key saveSummary uses, so the dedup check looks in the
      // right place (a UTC key would miss and cause re-summarizing).
      const date = localDateKey(e.internalDate ? Number(e.internalDate) : Date.now());
      const exists = await hasSummary(date, e.id);
      return exists ? null : e;
    })
  );
  const emailsToProcess = newOnly.filter(Boolean).slice(0, 20) as RawEmail[];

  if (!emailsToProcess.length) {
    console.log("No new emails");
    return { ok: true, newCount: 0, newSummaries: [] };
  }

  console.log(`Summarizing ${emailsToProcess.length} emails via rotating router...`);
  const summaries: Summary[] = [];
  try {
    const BATCH = 5;
    for (let i = 0; i < emailsToProcess.length; i += BATCH) {
      const batch = emailsToProcess.slice(i, i + BATCH);
      const { summaries: batchSummaries, usage, model, limits } =
        await summarizeEmails(batch, config.categories);
      summaries.push(...batchSummaries);
      await addGroqUsage(usage, { model, limits }).catch(console.error);
    }
  } catch (err) {
    console.error("Rotating-router summarization failed:", (err as Error).message);
    return {
      ok: false,
      error: `Router error: ${(err as Error).message}`,
      newCount: 0,
      newSummaries: [],
    };
  }

  console.log(`Got ${summaries.length} summaries, saving...`);
  const now = new Date().toISOString();
  const instantAlerts: Summary[] = [];

  // Use SGT midnight (UTC+8) so emails after midnight SGT trigger alerts
  const SGT_OFFSET = 8 * 3600 * 1000;
  const todayStart = new Date(
    Math.floor((Date.now() + SGT_OFFSET) / 86400000) * 86400000 - SGT_OFFSET
  );

  for (const summary of summaries) {
    const original = emailsToProcess.find((e) => e.id === summary.emailId);
    const accountIndex = config.accounts.findIndex(
      (a) => a.label === summary.account
    );

    summary.urgency = applyVipBoost(summary.urgency, summary.from, config.vipSenders);
    summary.gmailLink = buildGmailLink(accountIndex, summary.emailId);
    summary.gmailWebLink = `https://mail.google.com/mail/u/${accountIndex}/#inbox/${summary.emailId}`;
    summary.receivedAt = original?.internalDate
      ? new Date(Number(original.internalDate)).toISOString()
      : now;
    summary.processedAt = now;
    summary.reviewed = false;

    await saveSummary(summary);

    const isToday = new Date(summary.receivedAt) >= todayStart;
    if (isToday && summary.urgency >= config.notifications.instantAlertThreshold) {
      instantAlerts.push(summary);
    }
  }

  // Sort by urgency desc, cap at 5 to stay within function timeout
  instantAlerts.sort((a, b) => b.urgency - a.urgency);
  const alertsToSend = instantAlerts.slice(0, 5);

  for (let i = 0; i < alertsToSend.length; i++) {
    try {
      await sendInstantAlert(config, alertsToSend[i]);
    } catch (err) {
      console.error("Alert send failed:", (err as Error).message);
    }
    // Telegram rate limit: 1 msg/sec per chat
    if (i < alertsToSend.length - 1) await new Promise((r) => setTimeout(r, 1100));
  }

  return { ok: true, newCount: summaries.length, newSummaries: summaries };
}

async function sendInstantAlert(config: MailConfig, summary: Summary) {
  const { telegram } = config.notifications;
  if (telegram.enabled && telegram.botToken && telegram.chatId) {
    await sendTelegramMessage(
      telegram.botToken,
      telegram.chatId,
      formatInstantAlert(summary)
    ).catch(console.error);
  }
}
