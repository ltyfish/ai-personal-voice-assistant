import { schedule } from "@netlify/functions";

function siteUrl() {
  return process.env.URL || process.env.DEPLOY_PRIME_URL || process.env.DEPLOY_URL || "";
}

async function ping(path) {
  const base = siteUrl();
  if (!base) return new Response("Missing Netlify site URL", { status: 500 });
  const headers = {};
  if (process.env.CRON_SECRET) headers.authorization = `Bearer ${process.env.CRON_SECRET}`;
  const res = await fetch(`${base}${path}`, { headers });
  const body = await res.text();
  return new Response(body, {
    status: res.ok ? 200 : 502,
    headers: { "content-type": res.headers.get("content-type") || "application/json" },
  });
}

export const handler = schedule("*/10 * * * *", async () => {
  return await ping("/api/mail/fetch-emails");
});
