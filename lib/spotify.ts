// Spotify Web API — real playback control (Premium required).
//
// OAuth Authorization Code flow. We store the refresh token (and a cached access
// token) in the existing mail_kv table under namespace "spotify". Playback acts
// on the user's currently-active Spotify device (e.g. the desktop app — which
// the local bridge can open). All of this runs server-side; no bridge needed.

import { eq, and } from "drizzle-orm";
import { db, mailKv } from "@/db";

const AUTH_BASE = "https://accounts.spotify.com";
const API_BASE = "https://api.spotify.com/v1";

// Scopes: control playback, read player state, read/own playlists, and
// save tracks to the library ("like this song").
export const SPOTIFY_SCOPES = [
  "user-modify-playback-state",
  "user-read-playback-state",
  "user-read-currently-playing",
  "user-library-read",
  "user-library-modify",
  "playlist-read-private",
  "playlist-read-collaborative",
].join(" ");

const NS = "spotify";
const KEY = "tokens";

type StoredTokens = {
  refresh_token: string;
  access_token?: string;
  expires_at?: number; // epoch ms
};

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

export function clientId() {
  return env("SPOTIFY_CLIENT_ID");
}
export function redirectUri() {
  return env("SPOTIFY_REDIRECT_URI");
}

function basicAuth() {
  const creds = `${env("SPOTIFY_CLIENT_ID")}:${env("SPOTIFY_CLIENT_SECRET")}`;
  return "Basic " + Buffer.from(creds).toString("base64");
}

async function loadTokens(): Promise<StoredTokens | null> {
  const rows = await db
    .select({ value: mailKv.value })
    .from(mailKv)
    .where(and(eq(mailKv.namespace, NS), eq(mailKv.key, KEY)));
  return rows.length ? (rows[0].value as StoredTokens) : null;
}

async function saveTokens(t: StoredTokens) {
  await db
    .insert(mailKv)
    .values({ namespace: NS, key: KEY, value: t as object })
    .onConflictDoUpdate({
      target: [mailKv.namespace, mailKv.key],
      set: { value: t as object, updatedAt: new Date() },
    });
}

export async function isConnected(): Promise<boolean> {
  const t = await loadTokens();
  return !!t?.refresh_token;
}

// --- OAuth ----------------------------------------------------------------
export function authorizeUrl(state: string): string {
  const p = new URLSearchParams({
    response_type: "code",
    client_id: clientId(),
    scope: SPOTIFY_SCOPES,
    redirect_uri: redirectUri(),
    state,
  });
  return `${AUTH_BASE}/authorize?${p.toString()}`;
}

// Exchange the auth code for tokens and persist the refresh token.
export async function exchangeCode(code: string): Promise<void> {
  const res = await fetch(`${AUTH_BASE}/api/token`, {
    method: "POST",
    headers: {
      Authorization: basicAuth(),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(),
    }),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${await res.text()}`);
  const data = await res.json();
  await saveTokens({
    refresh_token: data.refresh_token,
    access_token: data.access_token,
    expires_at: Date.now() + (data.expires_in ?? 3600) * 1000,
  });
}

// Return a valid access token, refreshing (and re-storing) when expired.
async function getAccessToken(): Promise<string> {
  const t = await loadTokens();
  if (!t?.refresh_token) {
    throw new Error("Spotify isn't connected. Visit /api/spotify/login once.");
  }
  if (t.access_token && t.expires_at && t.expires_at > Date.now() + 30_000) {
    return t.access_token;
  }
  const res = await fetch(`${AUTH_BASE}/api/token`, {
    method: "POST",
    headers: {
      Authorization: basicAuth(),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: t.refresh_token,
    }),
  });
  if (!res.ok) throw new Error(`token refresh failed: ${await res.text()}`);
  const data = await res.json();
  const next: StoredTokens = {
    // Spotify may or may not return a new refresh token; keep the old one if not.
    refresh_token: data.refresh_token ?? t.refresh_token,
    access_token: data.access_token,
    expires_at: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
  await saveTokens(next);
  return next.access_token!;
}

async function api(
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  const token = await getAccessToken();
  return fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
}

// --- Devices --------------------------------------------------------------
type Device = { id: string; name: string; is_active: boolean; type: string };

async function getDevices(): Promise<Device[]> {
  const res = await api("/me/player/devices");
  if (!res.ok) return [];
  const data = await res.json();
  return data.devices ?? [];
}

type DevicePick = { id: string } | { error: string };

// Resolve WHICH device a command targets.
//   • hint given ("computer", "laptop", "phone", or a device name) → that device,
//     and if it isn't currently visible to Spotify, an error naming what IS (so
//     "play X on my computer" with the desktop app closed says so, not silently
//     plays on the phone).
//   • no hint → DEFAULT to the user's PHONE (they have a laptop + phone and want
//     the phone by default). For control actions (preferActive), the device
//     that's actually playing wins first so "pause"/"skip" hit the right one.
async function pickDevice(
  hint?: string | null,
  opts: { preferActive?: boolean } = {}
): Promise<DevicePick> {
  const devices = await getDevices();
  if (!devices.length) return { error: NO_DEVICE };
  const byType = (t: string) => devices.find((d) => d.type?.toLowerCase() === t);
  const phone = byType("smartphone");
  const computer = byType("computer");
  const active = devices.find((d) => d.is_active);

  const h = (hint || "").trim().toLowerCase();
  if (h) {
    const wantPhone = /\b(phone|mobile|cell|handphone|iphone|android)\b/.test(h);
    const wantComputer = /\b(computer|laptop|pc|desktop|mac)\b/.test(h);
    const dev =
      devices.find((d) => d.name.toLowerCase() === h) ||
      devices.find((d) => d.name.toLowerCase().includes(h)) ||
      (wantPhone ? phone : undefined) ||
      (wantComputer ? computer : undefined);
    if (dev) return { id: dev.id };
    const available = devices.map((d) => d.name).join(", ");
    const which = wantComputer
      ? "your computer"
      : wantPhone
      ? "your phone"
      : `“${hint}”`;
    return {
      error: `I don't see ${which} on Spotify right now — open the Spotify app there, then ask again. Available now: ${available}.`,
    };
  }

  // No hint: default to the phone. Control actions prefer whatever's already
  // playing so they don't yank playback to a silent phone.
  const pick = opts.preferActive
    ? active ?? phone ?? computer ?? devices[0]
    : phone ?? active ?? computer ?? devices[0];
  return { id: pick.id };
}

const NO_DEVICE =
  "No active Spotify device. Open the Spotify app first, then try again.";

// --- Playback -------------------------------------------------------------
export type SpotifyResult = { ok: boolean; message: string };

// Search for a track and start playing it. Defaults to the phone; pass `device`
// ("computer"/"laptop"/"phone"/a device name) to target a specific one.
export async function playQuery(query: string, device?: string | null): Promise<SpotifyResult> {
  const q = (query || "").trim();
  if (!q) return { ok: false, message: "Nothing to play." };

  const search = await api(
    `/search?type=track&limit=1&q=${encodeURIComponent(q)}`
  );
  if (!search.ok) return { ok: false, message: "Spotify search failed." };
  const track = (await search.json()).tracks?.items?.[0];
  if (!track) return { ok: false, message: `Couldn't find “${q}” on Spotify.` };

  const dev = await pickDevice(device);
  if ("error" in dev) return { ok: false, message: dev.error };
  const deviceId = dev.id;

  const res = await api(`/me/player/play?device_id=${deviceId}`, {
    method: "PUT",
    body: JSON.stringify({ uris: [track.uri] }),
  });
  if (!res.ok && res.status !== 204) {
    if (res.status === 403)
      return { ok: false, message: "Playback failed — Spotify Premium is required." };
    return { ok: false, message: `Couldn't start playback (${res.status}).` };
  }
  const who = track.artists?.map((a: any) => a.name).join(", ");
  return { ok: true, message: `Playing “${track.name}”${who ? ` by ${who}` : ""}.` };
}

async function simple(
  method: string,
  path: string,
  okMsg: string
): Promise<SpotifyResult> {
  // Control acts on whatever's already playing, falling back to the phone.
  const dev = await pickDevice(null, { preferActive: true });
  if ("error" in dev) return { ok: false, message: dev.error };
  const deviceId = dev.id;
  const sep = path.includes("?") ? "&" : "?";
  const res = await api(`${path}${sep}device_id=${deviceId}`, { method });
  if (!res.ok && res.status !== 204) {
    if (res.status === 403)
      return { ok: false, message: "Spotify Premium is required for that." };
    return { ok: false, message: `That didn't work (${res.status}).` };
  }
  return { ok: true, message: okMsg };
}

export const pause = () => simple("PUT", "/me/player/pause", "Paused.");
export const resume = () => simple("PUT", "/me/player/play", "Resumed.");
export const next = () => simple("POST", "/me/player/next", "Skipped to the next track.");
export const previous = () =>
  simple("POST", "/me/player/previous", "Went to the previous track.");

export async function setVolume(percent: number): Promise<SpotifyResult> {
  const v = Math.max(0, Math.min(100, Math.round(percent)));
  return simple("PUT", `/me/player/volume?volume_percent=${v}`, `Volume set to ${v}%.`);
}

export async function nowPlaying(): Promise<SpotifyResult> {
  const res = await api("/me/player/currently-playing");
  if (res.status === 204) return { ok: true, message: "Nothing is playing." };
  if (!res.ok) return { ok: false, message: "Couldn't read what's playing." };
  const data = await res.json();
  const item = data.item;
  if (!item) return { ok: true, message: "Nothing is playing." };
  const who = item.artists?.map((a: any) => a.name).join(", ");
  return { ok: true, message: `Now playing “${item.name}”${who ? ` by ${who}` : ""}.` };
}

// --- Shuffle / repeat -----------------------------------------------------
export async function setShuffle(on: boolean): Promise<SpotifyResult> {
  return simple(
    "PUT",
    `/me/player/shuffle?state=${on}`,
    on ? "Shuffle on." : "Shuffle off."
  );
}

// mode: "off" | "one" (repeat the track) | "all" (repeat the context)
export async function setRepeat(mode: string): Promise<SpotifyResult> {
  const state = mode === "one" ? "track" : mode === "all" ? "context" : "off";
  const label =
    state === "track" ? "Repeating this track." : state === "context" ? "Repeating all." : "Repeat off.";
  return simple("PUT", `/me/player/repeat?state=${state}`, label);
}

// --- Seek -----------------------------------------------------------------
export async function seek(seconds: number): Promise<SpotifyResult> {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const at = seconds <= 0 ? "the start" : `${Math.round(seconds)}s`;
  return simple("PUT", `/me/player/seek?position_ms=${ms}`, `Jumped to ${at}.`);
}

// --- Queue ----------------------------------------------------------------
export async function queueTrack(query: string, device?: string | null): Promise<SpotifyResult> {
  const q = (query || "").trim();
  if (!q) return { ok: false, message: "Nothing to queue." };
  const search = await api(`/search?type=track&limit=1&q=${encodeURIComponent(q)}`);
  if (!search.ok) return { ok: false, message: "Spotify search failed." };
  const track = (await search.json()).tracks?.items?.[0];
  if (!track) return { ok: false, message: `Couldn't find “${q}”.` };
  const dev = await pickDevice(device);
  if ("error" in dev) return { ok: false, message: dev.error };
  const deviceId = dev.id;
  const res = await api(
    `/me/player/queue?uri=${encodeURIComponent(track.uri)}&device_id=${deviceId}`,
    { method: "POST" }
  );
  if (!res.ok && res.status !== 204)
    return { ok: false, message: `Couldn't queue that (${res.status}).` };
  return { ok: true, message: `Added “${track.name}” to the queue.` };
}

// --- Play album / playlist / artist ---------------------------------------
// Find the user's OWN playlist by name (so "play my Discover Weekly" works).
async function findOwnedPlaylist(query: string): Promise<string | null> {
  const q = query.toLowerCase();
  const res = await api("/me/playlists?limit=50");
  if (!res.ok) return null;
  const items = (await res.json()).items ?? [];
  const hit =
    items.find((p: any) => p.name?.toLowerCase() === q) ||
    items.find((p: any) => p.name?.toLowerCase().includes(q));
  return hit?.uri ?? null;
}

// type: "album" | "playlist" | "artist". Plays the whole context (artist plays
// their popular tracks).
export async function playContext(
  query: string,
  type: string,
  device?: string | null
): Promise<SpotifyResult> {
  const q = (query || "").trim();
  if (!q) return { ok: false, message: "Nothing to play." };

  let uri: string | null = null;
  let name = q;
  if (type === "playlist") uri = await findOwnedPlaylist(q); // prefer your own
  if (!uri) {
    const search = await api(
      `/search?type=${type}&limit=1&q=${encodeURIComponent(q)}`
    );
    if (!search.ok) return { ok: false, message: "Spotify search failed." };
    const item = (await search.json())[`${type}s`]?.items?.[0];
    if (!item) return { ok: false, message: `Couldn't find that ${type}.` };
    uri = item.uri;
    name = item.name;
  }

  const dev = await pickDevice(device);
  if ("error" in dev) return { ok: false, message: dev.error };
  const deviceId = dev.id;
  const res = await api(`/me/player/play?device_id=${deviceId}`, {
    method: "PUT",
    body: JSON.stringify({ context_uri: uri }),
  });
  if (!res.ok && res.status !== 204) {
    if (res.status === 403)
      return { ok: false, message: "Playback failed — Spotify Premium is required." };
    return { ok: false, message: `Couldn't start playback (${res.status}).` };
  }
  return { ok: true, message: `Playing ${type} “${name}”.` };
}

// --- Save / like the current track ----------------------------------------
export async function saveCurrent(): Promise<SpotifyResult> {
  const res = await api("/me/player/currently-playing");
  if (res.status === 204) return { ok: false, message: "Nothing is playing to save." };
  if (!res.ok) return { ok: false, message: "Couldn't read what's playing." };
  const item = (await res.json()).item;
  if (!item?.id) return { ok: false, message: "Nothing is playing to save." };
  const put = await api(`/me/tracks?ids=${item.id}`, { method: "PUT" });
  if (!put.ok && put.status !== 200)
    return { ok: false, message: `Couldn't save that (${put.status}).` };
  return { ok: true, message: `Saved “${item.name}” to your library.` };
}

// --- Transfer to another device -------------------------------------------
export async function transfer(name: string): Promise<SpotifyResult> {
  const q = (name || "").trim().toLowerCase();
  const devices = await getDevices();
  if (!devices.length) return { ok: false, message: NO_DEVICE };
  const dev =
    devices.find((d) => d.name.toLowerCase() === q) ||
    devices.find((d) => d.name.toLowerCase().includes(q)) ||
    ((q.includes("phone") || q.includes("mobile")) &&
      devices.find((d) => d.type?.toLowerCase() === "smartphone")) ||
    ((q.includes("computer") || q.includes("laptop") || q.includes("pc")) &&
      devices.find((d) => d.type?.toLowerCase() === "computer"));
  if (!dev) {
    // Spotify only lists devices whose app is currently open/awake, so a missing
    // phone usually means its Spotify app is closed — say so, and name what IS
    // available so the user can pick a real one.
    const available = devices.map((d) => d.name).join(", ");
    const wantsPhone = q.includes("phone") || q.includes("mobile");
    return {
      ok: false,
      message: wantsPhone
        ? `I don't see your phone — open the Spotify app on it so it shows up, then ask again. Available now: ${available}.`
        : `Couldn't find a device called “${name}”. Available now: ${available}.`,
    };
  }
  const res = await api("/me/player", {
    method: "PUT",
    body: JSON.stringify({ device_ids: [dev.id], play: true }),
  });
  if (!res.ok && res.status !== 204)
    return { ok: false, message: `Couldn't switch device (${res.status}).` };
  return { ok: true, message: `Playing on ${dev.name}.` };
}
