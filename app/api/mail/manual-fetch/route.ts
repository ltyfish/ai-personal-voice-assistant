import { requireAuth, json } from "@/lib/mail/auth";
import { getConfig, getPollState, savePollState } from "@/lib/mail/blobs";
import { fetchNewEmails } from "@/lib/mail/gmail";
import { runFetch } from "@/lib/mail/fetch";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
  const authError = requireAuth(req);
  if (authError) return authError;

  const config = await getConfig();
  const pollState = await getPollState();
  const results: Record<string, unknown>[] = [];

  const { searchParams } = new URL(req.url);
  const hoursBack = Number(searchParams.get("hoursBack") ?? 0);

  for (const account of config.accounts) {
    const lastPoll = hoursBack
      ? new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString()
      : pollState.accounts?.[account.label]?.lastPoll ??
        new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    try {
      if (!account.refreshToken)
        throw new Error("No refresh token saved for this account");
      const emails = await fetchNewEmails(account.refreshToken, lastPoll);
      results.push({
        account: account.label,
        email: account.email,
        found: emails.length,
        lastPoll,
      });
    } catch (err) {
      results.push({
        account: account.label,
        email: account.email,
        error: (err as Error).message,
        lastPoll,
      });
    }
  }

  if (hoursBack) {
    const resetState = { accounts: {} as Record<string, { lastPoll: string }> };
    for (const account of config.accounts) {
      resetState.accounts[account.label] = {
        lastPoll: new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString(),
      };
    }
    await savePollState(resetState);
  }

  const res = await runFetch();
  return json({
    ok: res.ok,
    accounts: config.accounts.length,
    results,
    fetchError: res.error ?? null,
  });
}
