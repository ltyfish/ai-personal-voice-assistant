import { getConfig } from "@/lib/mail/blobs";
import { requireAuth, json } from "@/lib/mail/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const authError = requireAuth(req);
  if (authError) return authError;

  const config = await getConfig();
  const safe = {
    ...config,
    accounts: config.accounts.map((a) => ({ label: a.label, email: a.email })),
    notifications: {
      ...config.notifications,
      telegram: {
        enabled: config.notifications.telegram.enabled,
        chatId: config.notifications.telegram.chatId ? "***" : "",
      },
      whatsapp: {
        enabled: config.notifications.whatsapp.enabled,
        userPhone: config.notifications.whatsapp.userPhone,
      },
    },
  };
  return json(safe);
}
