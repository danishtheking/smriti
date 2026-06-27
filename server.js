/**
 * Smriti server — a thin proxy so the browser never holds any AI credential.
 *
 *   browser ──/api/*──▶ this server ──▶ Claude (Anthropic)        [primary]
 *                                    └▶ Gemini via Vertex / Dev API [fallback]
 *
 * The whole reason this proxy exists: every API key (Anthropic / Vertex / the
 * AssemblyAI voice key) must stay server-side and never reach the client. The
 * browser only ever gets a short-lived AssemblyAI token. See llm/provider.js.
 */
require('dotenv').config();
const express = require('express');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const provider = require('./llm/provider');

// Model routing: short, latency-sensitive replies use a fast model; heavier
// structured analysis uses a smart-but-quick model. Opus only if explicitly forced.
const FAST_MODEL    = 'claude-haiku-4-5';   // chat + next-action (1–4 sentence replies)
const SMART_MODEL   = 'claude-sonnet-4-6';  // journal analysis + session summary
const MAX_TRANSCRIPT = 8000;                 // chars forwarded into a paid prompt

// Log the real error server-side; return a generic message to the client.
const fail = (res, err, code = 502) => {
  console.error('[api error]', (err && err.stack) || err);
  res.status(code).json({ error: 'The AI request failed. Please try again.' });
};

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));   // baseline security headers (CSP off: CDN + inline)
app.use(express.json({ limit: '256kb' }));            // small body cap (was 4mb)

// Throttle the AI endpoints — each triggers a paid model call on a public URL.
app.use('/api/', rateLimit({ windowMs: 60_000, max: 40, standardHeaders: true, legacyHeaders: false }));
const tokenLimiter = rateLimit({ windowMs: 60_000, max: 10 });

// Serve ONLY index.html on "/" — no express.static, so .env / server.js / llm/*
// are never exposed as static files. All assets in index.html are inline or CDN.
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// Tells the frontend which billing path is live (vertex = GCP credits).
app.get('/api/health', (_req, res) => res.json(provider.status()));

// Tells the browser whether voice is available (does not expose any secret).
app.get('/api/config', (_req, res) => res.json({
  voiceProvider: 'assemblyai',
  voiceReady: !!process.env.ASSEMBLYAI_API_KEY
}));

// Mints a SHORT-LIVED AssemblyAI token so the browser can open the Voice Agent
// WebSocket without ever seeing the secret API key. The key stays server-side.
app.get('/api/voice-token', tokenLimiter, async (_req, res) => {
  try {
    const key = process.env.ASSEMBLYAI_API_KEY;
    if (!key) return res.status(503).json({ error: 'Voice is not configured.' });
    const r = await fetch('https://agents.assemblyai.com/v1/token?expires_in_seconds=300', {
      headers: { Authorization: `Bearer ${key}` }
    });
    const text = await r.text();
    let data = {}; try { data = JSON.parse(text); } catch {}
    if (!r.ok) { console.error('[voice-token]', r.status, text.slice(0, 200)); return res.status(502).json({ error: 'Could not start voice right now.' }); }
    res.json({ token: data.token });
  } catch (err) {
    fail(res, err);
  }
});

/* =================================================================================
   Smriti — voice check-in analysis
   ---------------------------------------------------------------------------------
   Takes the raw conversation transcript and returns a structured wellness read:
   mood, emotions, the HIDDEN stress triggers underneath, an empathetic summary,
   one coping strategy, and a safety risk level. Reuses provider.generatePlan —
   the same Claude structured-output path the rest of the app already uses.
   ================================================================================= */

// Gemini-style schema (UPPERCASE TYPE) — provider.js converts it for Claude.
const ANALYSIS_SCHEMA = {
  type: 'OBJECT',
  properties: {
    mood:      { type: 'NUMBER' },  // 1 (very low) … 10 (great)
    moodLabel: { type: 'STRING' },  // one word, e.g. "Anxious", "Hopeful"
    emotions:  { type: 'ARRAY', items: { type: 'STRING' } },
    stressTriggers: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          trigger:  { type: 'STRING' },  // the underlying cause, e.g. "Parental expectation"
          evidence: { type: 'STRING' }   // short quote/paraphrase from what they said
        },
        required: ['trigger']
      }
    },
    summary:        { type: 'STRING' },  // 1–2 warm sentences, second person ("You…")
    copingStrategy: { type: 'STRING' },  // one concrete, doable suggestion for tonight
    riskLevel:      { type: 'STRING' }   // "none" | "low" | "elevated" | "crisis"
  },
  required: ['mood', 'moodLabel', 'summary', 'stressTriggers', 'riskLevel']
};

function analysisPrompt(transcript) {
  return `You are a warm, perceptive mental-wellness analyst supporting students in India
preparing for high-stakes exams (NEET, JEE, CUET, CAT, GATE, UPSC). Below is the transcript
of a short spoken check-in between the student (user) and a voice companion (assistant).

Read it closely and return a structured wellness analysis. Your job is to surface what a
normal mood tracker would MISS: the hidden stress triggers underneath the surface mood.

Guidance:
- mood: 1–10 (1 = very low/distressed, 10 = great). Judge from the student's words, not the assistant's.
- moodLabel: a single word capturing the dominant feeling.
- stressTriggers: the REAL underlying causes (e.g. "Parental expectation", "Fear of failure",
  "Sleep deprivation", "Social comparison", "Self-doubt"), each with short evidence from what they said.
  Look beneath the obvious — if they're upset about a mock test, the trigger may be fear of disappointing family.
- summary: 1–2 sentences, warm and validating, written TO the student in second person.
- copingStrategy: ONE concrete, gentle action they can do tonight (a specific breathing exercise,
  a boundary, a reframe). Not generic advice.
- riskLevel: "crisis" if there is ANY hint of self-harm, hopelessness about living, or wanting to give up
  on life; "elevated" for severe burnout/panic; "low" for ordinary exam stress; "none" if they seem fine.

Return ONLY JSON matching the schema. No medical diagnosis. Be kind.

TRANSCRIPT:
${transcript}`;
}

app.post('/api/analyze', async (req, res) => {
  try {
    let { transcript } = req.body || {};
    if (!transcript || !String(transcript).trim())
      return res.status(400).json({ error: 'transcript is required' });
    transcript = String(transcript).slice(0, MAX_TRANSCRIPT);
    const result = await provider.generatePlan(analysisPrompt(transcript), ANALYSIS_SCHEMA, { temperature: 0.4, model: SMART_MODEL, maxTokens: 1024 });
    res.json({ provider: result.provider, model: result.model, analysis: result.plan });
  } catch (err) {
    fail(res, err);
  }
});

/* =================================================================================
   Smriti — companion chat (text) + one-line "next action" coach
   ---------------------------------------------------------------------------------
   Both reuse provider.generatePlan (structured output) so they work on whichever
   provider is configured (Claude / Vertex / Gemini). Voice chat is handled client-
   side by AssemblyAI; this /api/chat powers the typed fallback with the same persona,
   personalized with what the student has journaled (mood, hidden triggers, tasks).
   ================================================================================= */

const CHAT_SYSTEM = `You are Smriti, a warm, grounded companion for a student in India preparing for a high-stakes exam (NEET, JEE, CUET, CAT, GATE or UPSC). Reply briefly — 1 to 4 sentences — like a kind, steady friend. Validate how they feel before anything else. Never use toxic positivity ("just don't worry"), never diagnose. If they mention self-harm or hopelessness about living, gently and calmly encourage Tele-MANAS 14416 (India, free, 24x7) and talking to someone they trust.`;

const REPLY_SCHEMA = { type: 'OBJECT', properties: { reply: { type: 'STRING' } }, required: ['reply'] };

// Build a compact "what you already know about this student" block from their
// journaled data so the companion's replies are genuinely personalized.
function memoryBlock(ctx) {
  if (!ctx) return '';
  const f = [];
  if (ctx.mood != null) f.push(`current mood ${ctx.mood}/10${ctx.moodLabel ? ` (${ctx.moodLabel})` : ''}`);
  if (Array.isArray(ctx.triggers) && ctx.triggers.length) f.push(`recent stress triggers: ${ctx.triggers.slice(0, 4).join(', ')}`);
  if (ctx.summary) f.push(`their latest reflection: "${String(ctx.summary).slice(0, 300)}"`);
  if (Array.isArray(ctx.tasks) && ctx.tasks.length) f.push(`open tasks: ${ctx.tasks.slice(0, 5).join('; ')}`);
  if (Array.isArray(ctx.events) && ctx.events.length) f.push(`upcoming: ${ctx.events.slice(0, 3).join('; ')}`);
  return f.length
    ? `\n\nWhat you already know about this student (weave it in naturally when relevant — never list it back):\n- ${f.join('\n- ')}`
    : '';
}

function chatPrompt(messages, context) {
  const convo = (messages || [])
    .map(m => `${m.role === 'user' ? 'Student' : 'Smriti'}: ${String(m.text || '').trim()}`)
    .join('\n');
  return `${CHAT_SYSTEM}${memoryBlock(context)}\n\nConversation so far:\n${convo}\n\nWrite ONLY Smriti's next reply (no name prefix).`;
}

app.post('/api/chat', async (req, res) => {
  try {
    const { messages, context } = req.body || {};
    if (!Array.isArray(messages) || !messages.length)
      return res.status(400).json({ error: 'messages[] is required' });
    const trimmed = messages.slice(-50).map(m => ({ role: m.role, text: String(m.text || '').slice(0, 2000) }));
    const result = await provider.generatePlan(chatPrompt(trimmed, context), REPLY_SCHEMA, { temperature: 0.7, model: FAST_MODEL, maxTokens: 512 });
    res.json({ reply: result.plan.reply });
  } catch (err) {
    fail(res, err);
  }
});

const NEXT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    action: { type: 'STRING' },  // ONE short imperative line
    reason: { type: 'STRING' }    // <= 8 words, the "why"
  },
  required: ['action']
};

function nextActionPrompt(ctx) {
  return `You are a calm study-and-wellbeing coach for a student in India preparing for a high-stakes exam.
Given their current state, suggest the SINGLE best next action right now as ONE short imperative line
(max ~12 words, specific and doable). Balance wellbeing with progress: if they are clearly drained or
burnt out, the right next action may be to rest, breathe, or sleep — not to study harder.

Current local time: ${ctx.time || 'unknown'}
Latest mood (1=low,10=great): ${ctx.mood != null ? ctx.mood : 'unknown'} ${ctx.moodLabel || ''}
Most recent reflection: ${ctx.summary || 'none yet'}
Pending tasks: ${ctx.tasks && ctx.tasks.length ? ctx.tasks.join('; ') : 'none'}
Upcoming calendar items: ${ctx.events && ctx.events.length ? ctx.events.join('; ') : 'none'}

Return JSON: action (one imperative line), reason (max 8 words explaining why now).`;
}

app.post('/api/next-action', async (req, res) => {
  try {
    const ctx = (req.body && req.body.context) || {};
    const result = await provider.generatePlan(nextActionPrompt(ctx), NEXT_SCHEMA, { temperature: 0.5, model: FAST_MODEL, maxTokens: 256 });
    res.json({ action: result.plan.action, reason: result.plan.reason || '' });
  } catch (err) {
    fail(res, err);
  }
});

/* =================================================================================
   Smriti — turn a conversation into the day's journal + to-dos (the agentic bit)
   ---------------------------------------------------------------------------------
   One Claude call reads the whole chat/voice transcript and returns BOTH a wellbeing
   journal read AND the concrete tasks the student actually mentioned. Faithful only —
   it must not invent tasks. Works for voice and text alike.
   ================================================================================= */

const SESSION_SCHEMA = {
  type: 'OBJECT',
  properties: {
    journal: {
      type: 'OBJECT',
      properties: {
        mood:      { type: 'NUMBER' },
        moodLabel: { type: 'STRING' },
        summary:   { type: 'STRING' },
        stressTriggers: {
          type: 'ARRAY',
          items: { type: 'OBJECT', properties: { trigger: { type: 'STRING' }, evidence: { type: 'STRING' } }, required: ['trigger'] }
        },
        copingStrategy: { type: 'STRING' },
        riskLevel:      { type: 'STRING' }
      },
      required: ['mood', 'moodLabel', 'summary', 'riskLevel']
    },
    tasks: {
      type: 'ARRAY',
      items: { type: 'OBJECT', properties: { text: { type: 'STRING' }, due: { type: 'STRING' } }, required: ['text'] }
    }
  },
  required: ['journal', 'tasks']
};

function sessionPrompt(transcript, today) {
  return `You are Smriti, a warm wellbeing companion for a student in India preparing for a high-stakes exam (NEET, JEE, CUET, CAT, GATE or UPSC). Below is a conversation between the Student and you. Turn it into the student's daily record.

Produce TWO things as JSON:

1) journal — a wellbeing read of their day:
   - mood: 1 (very low) to 10 (great), judged from the STUDENT's words.
   - moodLabel: one word.
   - summary: 2-3 warm sentences written TO the student in second person, as their reflection for today.
   - stressTriggers: the real underlying causes, each with short evidence from what they said. Look beneath the surface (e.g. fear of disappointing family, comparison, exhaustion, self-doubt).
   - copingStrategy: one concrete, gentle thing to try tonight.
   - riskLevel: "crisis" if any hint of self-harm or hopelessness about living; "elevated" for severe burnout/panic; "low" for ordinary exam stress; "none" if they seem fine.

2) tasks — concrete to-do items the STUDENT actually mentioned needing to do, or explicitly agreed to as a next step (e.g. "Revise organic chemistry", "Sleep by 11pm", "Do 30 physics MCQs", "Call mom").
   - Be faithful: DO NOT invent tasks that were not discussed. If none were mentioned, return an empty array.
   - Keep each task short and actionable (imperative, max ~8 words).
   - due: a date "YYYY-MM-DD" ONLY if the student named a clear day; otherwise an empty string. Today is ${today || 'unknown'}.

Return ONLY JSON matching the schema.

TRANSCRIPT:
${transcript}`;
}

app.post('/api/session-summary', async (req, res) => {
  try {
    let { transcript, today } = req.body || {};
    if (!transcript || !String(transcript).trim())
      return res.status(400).json({ error: 'transcript is required' });
    transcript = String(transcript).slice(0, MAX_TRANSCRIPT);
    const result = await provider.generatePlan(sessionPrompt(transcript, today || ''), SESSION_SCHEMA, { temperature: 0.3, model: SMART_MODEL, maxTokens: 1024 });
    res.json({ journal: result.plan.journal, tasks: result.plan.tasks || [] });
  } catch (err) {
    fail(res, err);
  }
});

const PORT = process.env.PORT || 5599;
if (!process.env.VERCEL) app.listen(PORT, () => {
  const s = provider.status();
  const billing = s.provider === 'claude'
    ? `Claude API · model ${s.model}`
    : s.provider === 'vertex'
      ? `Vertex AI · project ${s.project} · USES GCP CREDITS ✅`
      : s.provider === 'developer'
        ? 'Gemini Developer API · ⚠ NOT GCP credits (fallback)'
        : 'NONE configured — set ANTHROPIC_API_KEY / Vertex creds / GEMINI_API_KEY in .env';
  console.log(`\nSmriti → http://localhost:${PORT}`);
  console.log(`Provider: ${billing}  (chat/next-action → ${FAST_MODEL}, analysis → ${SMART_MODEL})\n`);
});

// Serverless (Vercel): export the Express app so it can be used as the request handler.
module.exports = app;
