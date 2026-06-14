// Captures free-text "I wish I could say X to do Y" requests from the Abilities
// tab and appends them to a local markdown file (keyword-requests.md at the repo
// root). This is a stopgap inbox for domain/keyword ideas — there's no automatic
// processing; it's read by a human.
//
// NOTE: this writes to the local filesystem, so it persists when running locally
// (npm run dev). On a read-only/ephemeral serverless host (Vercel) the write will
// fail; we return ok:false with a hint rather than throwing, and the request is
// not stored. Move to mail_kv (like keywords/contacts) when this needs to work in
// production.

import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";

const FILE = path.join(process.cwd(), "keyword-requests.md");
const HEADER = "# Keyword / ability requests\n\nUser-submitted ideas from the Abilities tab (newest at the bottom).\n";

export async function GET() {
  try {
    const text = await fs.readFile(FILE, "utf8");
    return NextResponse.json({ ok: true, text });
  } catch {
    return NextResponse.json({ ok: true, text: "" });
  }
}

export async function POST(req: Request) {
  let body: { request?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid body" }, { status: 400 });
  }
  const text = String(body?.request ?? "").trim();
  if (!text) return NextResponse.json({ ok: false, error: "empty request" }, { status: 400 });
  if (text.length > 2000) {
    return NextResponse.json({ ok: false, error: "too long (max 2000 chars)" }, { status: 400 });
  }

  const entry = `\n## ${new Date().toISOString()}\n\n${text}\n`;
  try {
    // Seed the header on first write so the file is readable on its own.
    try {
      await fs.access(FILE);
    } catch {
      await fs.writeFile(FILE, HEADER, "utf8");
    }
    await fs.appendFile(FILE, entry, "utf8");
    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    // Read-only FS (e.g. serverless) — don't 500, just report it wasn't saved.
    const message = e instanceof Error ? e.message : "write failed";
    return NextResponse.json(
      { ok: false, error: `couldn't save to file (${message})` },
      { status: 200 }
    );
  }
}
