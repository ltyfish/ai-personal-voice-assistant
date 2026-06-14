// Contacts book for outbound messaging (WhatsApp / Telegram / email).
//
// Stored in the existing mail_kv table (namespace "contacts", key "book") so no
// schema migration is needed — same pattern as Spotify tokens and MailMind
// config. A contact only needs the handles for the channels you'll use:
//   phone     -> WhatsApp (E.164-ish, e.g. +6591234567)
//   telegram  -> a numeric chat id, or "@username" once they've messaged the bot
//   email     -> any address
//
// Names are matched loosely (exact -> startsWith -> includes, case-insensitive)
// so "text mom" finds the "Mom" contact.

import { and, eq } from "drizzle-orm";
import { db, mailKv } from "@/db";

const NS = "contacts";
const KEY = "book";

// Default country code for bare phone numbers (no "+"). The user speaks/saves a
// local number ("91234567") and we make it dialable as +65 91234567. Override
// with DEFAULT_COUNTRY_CODE (digits only, e.g. "1", "44").
const DEFAULT_CC = (process.env.DEFAULT_COUNTRY_CODE || "65").replace(/[^\d]/g, "");

// Make a phone number international/E.164-ish, defaulting the country code:
//   "+6591234567" / "+1 415…"  → kept (already has a country code)
//   "0065 9123 4567"            → "+6591234567" (00 = international prefix)
//   "91234567"                  → "+6591234567" (bare local → default CC)
//   "6591234567"                → "+6591234567" (already full, no double-prefix)
// The "already full" check only triggers for a number that's the default CC plus
// a full national number (≥8 digits), so a local SG number like "65123456" that
// merely starts with 65 still gets the prefix.
export function normalizePhone(raw: string, cc: string = DEFAULT_CC): string {
  const s = (raw || "").trim();
  if (!s) return "";
  if (s.startsWith("+")) return "+" + s.slice(1).replace(/\D/g, "");
  const d = s.replace(/\D/g, "");
  if (!d) return "";
  if (d.startsWith("00")) return "+" + d.slice(2);
  if (cc && d.startsWith(cc) && d.length >= cc.length + 8) return "+" + d;
  return "+" + cc + d;
}

export type Contact = {
  name: string;
  phone?: string; // for WhatsApp
  telegram?: string; // chat id or @username
  email?: string;
};

async function loadBook(): Promise<Contact[]> {
  const rows = await db
    .select({ value: mailKv.value })
    .from(mailKv)
    .where(and(eq(mailKv.namespace, NS), eq(mailKv.key, KEY)));
  const v = rows.length ? (rows[0].value as { contacts?: Contact[] }) : null;
  return Array.isArray(v?.contacts) ? v!.contacts : [];
}

async function saveBook(contacts: Contact[]) {
  await db
    .insert(mailKv)
    .values({ namespace: NS, key: KEY, value: { contacts } as object })
    .onConflictDoUpdate({
      target: [mailKv.namespace, mailKv.key],
      set: { value: { contacts } as object, updatedAt: new Date() },
    });
}

export async function listContacts(): Promise<Contact[]> {
  return loadBook();
}

// Loose name match so spoken names resolve: exact, then prefix, then substring.
export async function findContact(query: string): Promise<Contact | null> {
  const q = (query || "").trim().toLowerCase();
  if (!q) return null;
  const book = await loadBook();
  return (
    book.find((c) => c.name.toLowerCase() === q) ||
    book.find((c) => c.name.toLowerCase().startsWith(q)) ||
    book.find((c) => c.name.toLowerCase().includes(q)) ||
    null
  );
}

// Create or update a contact by name (case-insensitive). Only the handles you
// pass are changed; existing ones are preserved (so you can add a channel later).
export async function upsertContact(c: Contact): Promise<Contact> {
  const name = (c.name || "").trim();
  if (!name) throw new Error("contact name is required");
  const book = await loadBook();
  const idx = book.findIndex((x) => x.name.toLowerCase() === name.toLowerCase());
  const clean: Contact = { name };
  if (c.phone?.trim()) clean.phone = normalizePhone(c.phone);
  if (c.telegram?.trim()) clean.telegram = c.telegram.trim();
  if (c.email?.trim()) clean.email = c.email.trim();
  let merged: Contact;
  if (idx >= 0) {
    merged = { ...book[idx], ...clean, name: book[idx].name };
    book[idx] = merged;
  } else {
    merged = clean;
    book.push(merged);
  }
  await saveBook(book);
  return merged;
}

export async function deleteContact(name: string): Promise<boolean> {
  const q = (name || "").trim().toLowerCase();
  if (!q) return false;
  const book = await loadBook();
  const next = book.filter((c) => c.name.toLowerCase() !== q);
  if (next.length === book.length) return false;
  await saveBook(next);
  return true;
}
