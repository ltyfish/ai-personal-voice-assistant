import { getConfig } from "@/lib/mail/blobs";
import { requireAuth, json } from "@/lib/mail/auth";
import { refreshAccessToken } from "@/lib/mail/gmail";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function classifyError(err: unknown) {
  const msg = (err as Error)?.message || String(err || "");
  const needsReconnect = /invalid_grant|invalid_request|unauthorized_client/i.test(msg);
  return {
    ok: false,
    needsReconnect,
    error: needsReconnect
      ? "Gmail login expired. Reconnect this account."
      : msg || "Could not validate Gmail login.",
    code: /invalid_grant/i.test(msg) ? "invalid_grant" : "gmail_check_failed",
  };
}

export async function GET(req: Request) {
  const authError = requireAuth(req);
  if (authError) return authError;

  const config = await getConfig();
  const accounts = await Promise.all(
    config.accounts.map(async (account, index) => {
      if (!account.refreshToken) {
        return {
          index,
          label: account.label,
          email: account.email,
          ok: false,
          needsReconnect: true,
          error: "No Gmail refresh token saved. Reconnect this account.",
          code: "missing_refresh_token",
        };
      }
      try {
        await refreshAccessToken(account.refreshToken);
        return {
          index,
          label: account.label,
          email: account.email,
          ok: true,
          needsReconnect: false,
        };
      } catch (err) {
        return {
          index,
          label: account.label,
          email: account.email,
          ...classifyError(err),
        };
      }
    }),
  );

  return json({ ok: true, accounts });
}
