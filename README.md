# Personal AI

Voice-driven personal assistant + dashboard for your **tasks, calendar, and notes** — available as a website
and a floating Windows desktop pet.
Press and hold the mic, speak a command, and the assistant updates your data and talks back. You can
also edit everything by hand on the dashboard.

## Stack

- **Next.js** (App Router, TypeScript) — website + API routes
- **Neon** Postgres + **Drizzle ORM** — data
- **Groq** — Whisper STT + Llama tool-calling LLM
- **Browser SpeechSynthesis** — free text-to-speech reply
- **Electron** — always-on-top Windows pet with wake-word listening and local actions
- **GitHub Releases** — Windows installer and automatic desktop updates
- No auth (single user) for V1

## How the voice flow works

```
Hold mic (MediaRecorder)
  → POST /api/voice  (webm audio)
  → Groq Whisper  (speech → text)
  → runAgent()    (Groq Llama decides tool calls)
  → lib/tools.ts  (reads/writes Neon via Drizzle)
  → spoken reply  (browser TTS) + dashboard refresh
```

## Setup

1. **Install deps**

   ```bash
   npm install
   ```

2. **Create a Neon database** at https://neon.tech and copy the **pooled** connection string.

3. **Get a Groq API key** at https://console.groq.com/keys

4. **Configure env**

   ```bash
   cp .env.local.example .env.local
   # fill in DATABASE_URL, GROQ_API_KEY, ASSISTANT_TIMEZONE
   ```

5. **Create the tables**

   ```bash
   npm run db:push
   ```

6. **Run**

   ```bash
   npm run dev
   ```

   Open http://localhost:3000

## Try saying

- "Add gym tomorrow 7 to 8 pm."
- "Remind me to submit the assignment Friday."
- "Add a note: buy oats and milk."
- "What do I have today?"
- "What are my open tasks?"

## Notes on cost / Groq sharing

- Default model is `llama-3.1-8b-instant` (high free-tier daily limit). Your email-summarizer
  project can stay on `llama-3.3-70b-versatile` — different model = separate rate-limit bucket,
  so the two projects won't starve each other.
- Microphone + TTS require **HTTPS** (or `localhost`). On a deployed phone PWA, use the Vercel URL.

## Deploy

Push to GitHub and import into Vercel. Add the same env vars in the Vercel project settings.
Mic capture works on the `https://` Vercel domain.

## JARVIS Desktop Pet

Download the newest Windows installer:

[Download JARVIS Desktop](https://github.com/ltyfish/ai-personal-voice-assistant/releases/latest/download/JARVIS-Desktop-Setup.exe)

The pet is a lightweight companion to the cloud website. It uses the same `/api/voice` route, model
rotation, tasks, calendar, notes, and shared data. Use **Open JARVIS** in the pet to open the full site.

The first installation is manual. Later releases download automatically; the pet waits for
**Restart and update** before installing them.

See [Desktop Pet and Updates](docs/DESKTOP_PET.md) for behavior, image stages, development commands,
release publishing, and troubleshooting.
