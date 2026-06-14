import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (p) => readFileSync(join(root, p), "utf8");
const assert = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  }
};

const mailLlm = read("lib/mail/groq.ts");
const fetch = read("lib/mail/fetch.ts");
const digest = read("lib/mail/digest.ts");
const netlifyFetch = read("netlify/functions/mail-fetch.mjs");
const netlifyDigest = read("netlify/functions/mail-digest.mjs");
const netlifyToml = read("netlify.toml");

assert(
  /routeChatCompletion/.test(mailLlm) &&
    /model:\s*"auto"/.test(mailLlm) &&
    !/groq as client/.test(mailLlm) &&
    !/FALLBACK_MODELS/.test(mailLlm),
  "MailMind summarizer must use the native rotating router auto model, not the old Groq SDK fallback."
);

assert(
  /summarizeEmails/.test(fetch) &&
    /Summarizing \$\{emailsToProcess\.length\} emails via rotating router/.test(fetch),
  "Email polling summaries must go through the rotating-router summarizer."
);

assert(
  /synthesizeCategorySummary/.test(digest) &&
    /getDigestState/.test(digest) &&
    /saveDigestState/.test(digest) &&
    /digestDueNow/.test(digest),
  "Digest summaries must use rotating-router synthesis and track digest send state."
);

assert(
  !/sendWhatsAppMessage/.test(fetch) &&
    !/formatInstantAlertPlain/.test(fetch) &&
    !/sendWhatsAppMessage/.test(digest) &&
    !/formatDigestPlainText/.test(digest),
  "Scheduled MailMind fetch/digest paths must send Telegram only."
);

assert(
  /pollingIntervalMin/.test(digest) &&
    /sentKey/.test(digest) &&
    /already-sent/.test(digest),
  "Digest timing must respect configured digest times under a polling cron and avoid duplicate sends."
);

assert(
  /directory = "netlify\/functions"/.test(netlifyToml) &&
    /schedule\("\*\/10 \* \* \* \*"/.test(netlifyFetch) &&
    /\/api\/mail\/fetch-emails/.test(netlifyFetch) &&
    /schedule\("\*\/10 \* \* \* \*"/.test(netlifyDigest) &&
    /\/api\/mail\/daily-digest/.test(netlifyDigest),
  "Netlify scheduled functions must ping fetch and digest endpoints every 10 minutes."
);

if (!process.exitCode) console.log("mailmind router cron checks ok");
