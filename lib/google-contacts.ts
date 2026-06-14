// Import Google Contacts into the messaging contacts book.
//
// Reuses the SAME Google account(s) already connected for MailMind (their
// refresh tokens live in MailMind config.accounts). After the contacts.readonly
// scope was added to the OAuth consent (lib/mail/gmail.ts), those refresh tokens
// can also read the People API — so no separate login is needed, just a one-time
// re-consent (reconnect Gmail) to grant the new scope.

import { google } from "googleapis";
import { buildOAuthClient } from "@/lib/mail/gmail";
import { getConfig } from "@/lib/mail/blobs";
import { upsertContact } from "@/lib/contacts";

export type ImportResult = {
  ok: boolean;
  imported: number; // contacts upserted (with at least one usable handle)
  skipped: number; // connections with no name or no phone/email
  accounts: number; // Google accounts read
  error?: string;
};

export type CreateResult = { ok: boolean; error?: string };

// Write a NEW contact to the user's Google Contacts (People API) so a contact
// added via Jarvis actually shows up in Google. Uses the first connected account.
// Best-effort: returns ok:false with a readable reason (not connected / scope not
// granted / API error) so the tool can tell the user, having already saved locally.
export async function createGoogleContact(c: {
  name: string;
  phone?: string;
  email?: string;
}): Promise<CreateResult> {
  const name = (c.name || "").trim();
  if (!name) return { ok: false, error: "no name" };

  const config = await getConfig();
  const acct = config.accounts.find((a) => a.refreshToken);
  if (!acct) {
    return { ok: false, error: "No Google account connected — connect Gmail in MailMind settings to save contacts to Google." };
  }

  const oAuth2Client = buildOAuthClient();
  oAuth2Client.setCredentials({ refresh_token: acct.refreshToken });
  const people = google.people({ version: "v1", auth: oAuth2Client });

  try {
    await people.people.createContact({
      requestBody: {
        names: [{ givenName: name }],
        ...(c.phone?.trim() ? { phoneNumbers: [{ value: c.phone.trim() }] } : {}),
        ...(c.email?.trim() ? { emailAddresses: [{ value: c.email.trim() }] } : {}),
      },
    });
    return { ok: true };
  } catch (e: any) {
    const msg = e?.message || "";
    if (/insufficient|scope|permission|403/i.test(msg)) {
      return {
        ok: false,
        error: "Google Contacts WRITE access isn't granted yet. Reconnect Gmail (re-consent) to add the contacts permission, then try again.",
      };
    }
    return { ok: false, error: msg || "Google contact create failed." };
  }
}

// Pull every connection with a name + at least one phone/email and upsert it.
export async function importGoogleContacts(): Promise<ImportResult> {
  const config = await getConfig();
  const accounts = config.accounts.filter((a) => a.refreshToken);
  if (!accounts.length) {
    return {
      ok: false,
      imported: 0,
      skipped: 0,
      accounts: 0,
      error:
        "No Google account is connected. Connect Gmail in MailMind settings first.",
    };
  }

  let imported = 0;
  let skipped = 0;

  for (const acct of accounts) {
    const oAuth2Client = buildOAuthClient();
    oAuth2Client.setCredentials({ refresh_token: acct.refreshToken });
    const people = google.people({ version: "v1", auth: oAuth2Client });

    let pageToken: string | undefined;
    do {
      let res;
      try {
        res = await people.people.connections.list({
          resourceName: "people/me",
          pageSize: 1000,
          personFields: "names,phoneNumbers,emailAddresses",
          pageToken,
          sortOrder: "LAST_MODIFIED_DESCENDING",
        });
      } catch (e: any) {
        // A 403 here almost always means the refresh token predates the
        // contacts scope — tell the user to reconnect Gmail to re-consent.
        const msg = e?.message || "";
        if (/insufficient|scope|permission|403/i.test(msg)) {
          return {
            ok: false,
            imported,
            skipped,
            accounts: accounts.length,
            error:
              "Google Contacts access wasn't granted yet. Reconnect Gmail (re-consent) so the contacts permission is added, then sync again.",
          };
        }
        return { ok: false, imported, skipped, accounts: accounts.length, error: msg };
      }

      const connections = res.data.connections ?? [];
      for (const p of connections) {
        const name =
          p.names?.find((n) => n.displayName)?.displayName?.trim() || "";
        const phone =
          p.phoneNumbers?.find((n) => n.value)?.value?.trim() || undefined;
        const email =
          p.emailAddresses?.find((e) => e.value)?.value?.trim() || undefined;
        if (!name || (!phone && !email)) {
          skipped++;
          continue;
        }
        await upsertContact({ name, phone, email });
        imported++;
      }
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
  }

  return { ok: true, imported, skipped, accounts: accounts.length };
}
