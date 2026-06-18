// Shared helpers for "local actions" the voice agent can ask the laptop to run.
//
// IMPORTANT: the web app (Vercel) cannot touch your machine. The agent only
// *proposes* an action; the browser asks you to confirm and forwards it to the
// local bridge (scripts/bridge/server.mjs), which is the only thing that
// actually launches anything. The bridge validates every target.

// What the bridge knows how to do:
//   "open"          -> open a URL / URI in the default handler (browser, Spotify…)
//   "open_app"      -> launch an installed app by name
//   "run_shell"     -> developer mode: run a PowerShell command (gated + confirmed)
//   "whatsapp_send" -> open WhatsApp on a chat with the message pre-filled, and
//                      (optionally) auto-press Enter to send it
//   "shutdown"      -> shut down (or cancel a pending shutdown of) the computer
export type LocalActionKind =
  | "open"
  | "open_app"
  | "run_shell"
  | "whatsapp_send"
  | "shutdown";

// A proposed action handed back to the browser to confirm + run.
export type LocalActionIntent = {
  local_action: LocalActionKind;
  target: string; // url/uri to open, or app name to launch
  label: string; // human phrase for the confirmation prompt ("open <label>?")
  fallback?: string; // for open_app: website to open if the app isn't installed
  only?: "app" | "folder"; // for open_app: force just this kind (user said "X app"/"X folder")
  command?: string; // for run_shell: the literal PowerShell command to run
  autoSend?: boolean; // for whatsapp_send: bridge presses Enter after opening
  delaySec?: number; // for shutdown: seconds before the machine powers off
  cancel?: boolean; // for shutdown: abort a pending shutdown instead of starting one
};

// Friendly site names -> URLs, so "open YouTube" works without a full URL.
const SITES: Record<string, string> = {
  youtube: "https://www.youtube.com",
  gmail: "https://mail.google.com",
  google: "https://www.google.com",
  twitter: "https://twitter.com",
  x: "https://x.com",
  github: "https://github.com",
  maps: "https://maps.google.com",
  "google maps": "https://maps.google.com",
  reddit: "https://www.reddit.com",
  instagram: "https://www.instagram.com",
  facebook: "https://www.facebook.com",
  whatsapp: "https://web.whatsapp.com",
  netflix: "https://www.netflix.com",
  chatgpt: "https://chatgpt.com",
  spotify: "https://open.spotify.com",
};

// Resolve what the user said into an https URL.
//   - a full http(s) URL is used as-is
//   - a known site name maps to its URL
//   - anything else becomes https://www.<slug>.com (best effort)
export function resolveUrl(site: string): string {
  const q = (site || "").trim();
  if (/^https?:\/\//i.test(q)) return q;
  const key = q.toLowerCase();
  if (SITES[key]) return SITES[key];
  const slug = key.replace(/^www\./, "").replace(/\s+/g, "");
  if (/\.[a-z]{2,}$/i.test(slug)) return `https://${slug}`; // e.g. "espn.com"
  return `https://www.${slug}.com`;
}

// Returns a URL only if we actually know one for this name (known site or a
// full URL). Used as the "else open the website" fallback for open_app — we do
// NOT guess https://www.<name>.com here, so "notepad" gets no bogus fallback.
export function knownSiteUrl(name: string): string | null {
  const q = (name || "").trim();
  if (/^https?:\/\//i.test(q)) return q;
  const key = q.toLowerCase();
  return SITES[key] ?? null;
}

export function searchUrl(query: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(
    (query || "").trim()
  )}`;
}

// Opens Spotify's in-app search for the song. Note: this opens Spotify on the
// track — it does NOT auto-play (that needs the Spotify Web API + Premium).
export function spotifySearchUri(query: string): string {
  return `spotify:search:${encodeURIComponent((query || "").trim())}`;
}
