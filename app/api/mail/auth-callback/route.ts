import { buildOAuthClient } from "@/lib/mail/gmail";
import { getConfig, saveConfig } from "@/lib/mail/blobs";
import type { MailAccount } from "@/lib/mail/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const code = searchParams.get("code");
    const stateRaw = searchParams.get("state") ?? "{}";
    const { label } = JSON.parse(stateRaw);

    if (!code) {
      return new Response("Missing code", { status: 400 });
    }

    const oAuth2Client = buildOAuthClient();
    const { tokens } = await oAuth2Client.getToken(code);

    const config = await getConfig();
    const email = await getUserEmail(tokens.access_token!);

    if (!email)
      throw new Error(
        "Could not retrieve email address from Google. Check OAuth scopes."
      );

    const existing = config.accounts.findIndex((a) => a.email === email);
    const account: MailAccount = {
      label: label || "Account",
      email,
      // Google often omits refresh_token on repeat consent. Keep the old one so
      // a harmless reconnect does not silently break polling.
      refreshToken:
        tokens.refresh_token ?? config.accounts[existing]?.refreshToken ?? undefined,
      lastPoll: new Date().toISOString(),
    };

    if (existing >= 0) {
      config.accounts[existing] = account;
    } else {
      config.accounts.push(account);
    }

    await saveConfig(config);
    const origin = new URL(req.url).origin;
    return Response.redirect(`${origin}/mail?connected=true`, 302);
  } catch (err) {
    return new Response(`Auth error: ${(err as Error).message}`, { status: 500 });
  }
}

async function getUserEmail(accessToken: string): Promise<string | undefined> {
  const res = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await res.json();
  return data.email;
}
