import { google } from "googleapis";

export function buildOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

export function getAuthUrl(oAuth2Client: ReturnType<typeof buildOAuthClient>, state: string) {
  return oAuth2Client.generateAuthUrl({
    access_type: "offline",
    scope: [
      "https://www.googleapis.com/auth/gmail.readonly",
      // Read-WRITE access to Google Contacts: import people for free messaging AND
      // push contacts added via Jarvis back to Google so they show up there.
      // Re-consent once (reconnect Gmail) to grant the upgraded scope.
      "https://www.googleapis.com/auth/contacts",
      "email",
      "profile",
    ],
    prompt: "consent",
    state,
  });
}

export async function refreshAccessToken(refreshToken: string) {
  const oAuth2Client = buildOAuthClient();
  oAuth2Client.setCredentials({ refresh_token: refreshToken });
  const { credentials } = await oAuth2Client.refreshAccessToken();
  return credentials.access_token;
}

export type RawEmail = {
  id: string;
  from: string;
  subject: string;
  date: string;
  body: string;
  internalDate?: string | null;
  account?: string;
  accountEmail?: string;
};

export async function fetchNewEmails(
  refreshToken: string,
  afterTimestamp: string
): Promise<RawEmail[]> {
  const oAuth2Client = buildOAuthClient();
  const accessToken = await refreshAccessToken(refreshToken);
  oAuth2Client.setCredentials({ access_token: accessToken });

  const gmail = google.gmail({ version: "v1", auth: oAuth2Client });
  const afterSec = Math.floor(new Date(afterTimestamp).getTime() / 1000);

  const listRes = await gmail.users.messages.list({
    userId: "me",
    q: `is:unread after:${afterSec}`,
    maxResults: 50,
  });

  const messages = listRes.data.messages ?? [];

  const emails = await Promise.all(
    messages.map(async ({ id }) => {
      const msg = await gmail.users.messages.get({
        userId: "me",
        id: id!,
        format: "full",
      });
      return parseMessage(id!, msg.data);
    })
  );

  return emails;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseMessage(id: string, data: any): RawEmail {
  const headers = data.payload?.headers ?? [];
  const get = (name: string) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    headers.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
  const body = extractBody(data.payload);
  return {
    id,
    from: get("From"),
    subject: get("Subject"),
    date: get("Date"),
    body,
    internalDate: data.internalDate,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractBody(payload: any): string {
  if (!payload) return "";
  if (payload.body?.data)
    return Buffer.from(payload.body.data, "base64").toString("utf-8");
  for (const part of payload.parts ?? []) {
    const text = extractBody(part);
    if (text) return text;
  }
  return "";
}

export function buildGmailLink(accountIndex: number, messageId: string) {
  const webUrl = encodeURIComponent(
    `https://mail.google.com/mail/u/${accountIndex}/#inbox/${messageId}`
  );
  return `https://gmail.app.goo.gl/?link=${webUrl}&apn=com.google.android.gm`;
}
