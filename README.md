# Smriti 🌙 — a voice-first wellbeing companion for exam students

> **Hack2Skill · PromptWars (Build with AI)** — Challenge: *Mental Wellness Tracker.*
> Smriti helps students preparing for high-stakes exams (NEET, JEE, CUET, CAT, GATE, UPSC)
> monitor and improve their mental wellbeing — by **talking or journaling**, and letting
> GenAI surface the **hidden stress triggers a normal mood tracker misses**.

**Run:** `npm install && npm start` → open the printed URL. Mobile-first, but fully responsive to laptop/desktop.

---

## How it maps to the challenge

| The brief asks for… | In Smriti |
|---|---|
| Analyze **open-ended daily journaling & mood logs** | Free-text check-in → Claude returns a mood score, label, and a warm reflection. |
| Uncover **hidden stress triggers & patterns standard trackers miss** | Every entry is mined for the *real underlying causes* (parental expectation, social comparison, sleep loss, self-doubt) **with an evidence quote** — this is the product's spine. |
| **Conversational AI** for support | Two real modalities: a **voice companion** (AssemblyAI Voice Agent, real-time with barge-in) and a **text chat** (Claude), sharing one persona. |
| **Hyper-personalized, contextual** support | The chat is fed the student's mood, recent triggers, tasks and reflection, so Smriti references what they actually journaled. |
| **Real-time tailored coping strategies** | Each analysis ends with one concrete coping step + a **“Start a 60-second breath →”** button. |
| **Adaptive mindfulness exercises** | A dedicated **Breathe** view with guided box / 4-7-8 / calm breathing; the journal insight & crisis banner deep-link into the technique best suited to the student's state. |
| **Motivational encouragement** | A daily **“next move”** coach turns mood + tasks + calendar into one kind, doable suggestion. |
| **Safe, empathetic, always-available companion** | Validate-first persona, never diagnoses, a `none → low → elevated → crisis` risk taxonomy, and **Tele-MANAS 14416** (India's free 24×7 line) always one tap away. |

The signature moment: a student says *“I bombed my mock test”* and Smriti surfaces the trigger
underneath — *fear of disappointing family* — not just the surface sadness. There's also an
agentic **“Wrap up”** that turns any conversation into the day's journal **and** the to-dos
the student mentioned, then plots mood-coloured history on a calendar.

## Features

- **Companion** — voice (AssemblyAI) + text (Claude), personalized by journal context.
- **Journal** — write a check-in → mood, hidden triggers (with evidence), summary, coping step, safety risk.
- **Breathe** — interactive, adaptive guided breathing (box / 4-7-8 / calm).
- **Tasks** — add / complete, with due dates; auto-extracted from conversations.
- **Calendar** — month view with mood-coloured dots; tap any day to revisit that check-in.
- **Home** — a one-line AI “next move”, quick actions, today's mood/tasks, and a mood trend.

## Architecture

```
Browser (index.html — one SPA, no build)
  · Tailwind (CDN) + Geist · light theme · responsive (mobile → desktop sidebar)
  · localStorage for all user data (no mock data; real entries only)
  · AssemblyAI voice over a single WebSocket (mic → PCM16 → token-authed)
        │  /api/*  (same origin)
        ▼
server.js (Express proxy — keeps every key server-side)
  · /api/analyze, /api/chat, /api/next-action, /api/session-summary  → Claude
  · /api/voice-token  → mints a short-lived AssemblyAI token (key never ships to client)
  · helmet + per-route rate-limiting + input-size caps
        │
        ▼
llm/provider.js (one entry point)
  · Claude (Anthropic SDK, forced-tool structured output) — primary
  · Gemini via Vertex AI / Developer API — automatic fallback
  · per-task model routing: Haiku for chat/next-action, Sonnet for analysis
```

**Security by design:** no API key ever reaches the browser — the server proxies every
model call and mints a 300-second AssemblyAI token. `.env` is git-ignored; `index.html` is
the only file served (no `express.static`); all model/user text is HTML-escaped before render.

## Run it

```bash
npm install
cp .env.example .env          # then fill in the keys
npm start                     # → http://localhost:5599
```

Minimum to run: `ANTHROPIC_API_KEY` (the AI brain). Add `ASSEMBLYAI_API_KEY` to enable the
voice companion — without it, text chat still works fully. See `.env.example`.

## Test

```bash
npm test            # Node's built-in runner — no extra dependencies
```

Covers the provider's pure seam: the Gemini→JSON-Schema converter (`toJsonSchema`) and the
env-driven provider resolution (`activeProvider`, `claudeConfigured`).

## How it scores against the rubric

| Parameter (weight) | What we did |
|---|---|
| **Code Quality** (High) | One clean SPA + a thin, schema-driven Express proxy + a documented provider abstraction; `esc()` discipline throughout; a real README and tests. |
| **Problem-Statement Alignment** (High) | Hidden-trigger discovery, dual-modality conversational AI, adaptive breathing, context-aware chat, and a concrete India-specific safety layer. |
| **Security** (Med) | Keys strictly server-side + short-lived voice token; helmet headers; per-route rate limiting; input-size caps; generic client errors; HTML-escaped output. |
| **Efficiency** (Med) | Per-task model routing (Haiku for short replies, Sonnet for analysis) with tight token ceilings; off-thread audio pipeline; bounded payloads. |
| **Testing** (Low) | `npm test` over the importable provider seam (schema converter + provider resolution). |
| **Accessibility** (Low) | Semantic landmarks, `aria-live` for AI/voice/crisis output, `aria-current`/`aria-checked` state, AA-contrast text, `prefers-reduced-motion`, full keyboard + typed fallback. |

## Tech

Single `index.html` (vanilla JS, Tailwind CDN, Geist) · Node/Express proxy ·
Claude (Anthropic) with forced-tool structured output · AssemblyAI Voice Agent API.

> Smriti is a supportive companion, not a medical device, and does not provide diagnosis or
> crisis treatment. In distress, contact **Tele-MANAS 14416** or **iCall 9152987821** (India, free).
