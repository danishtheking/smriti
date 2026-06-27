/**
 * Smriti LLM provider — one entry point, three possible backends:
 *   • Claude API (Anthropic SDK)            — easiest: just an API key
 *   • Gemini via Google Vertex AI           — uses GCP credits (service-account OAuth)
 *   • Gemini Developer API                  — API key; does NOT use GCP credits
 *
 * Resolution (auto): Claude (if ANTHROPIC_API_KEY) → Vertex (if configured) →
 * Developer API (if GEMINI_API_KEY) → none. Force one with LLM_PROVIDER.
 *
 * The Vertex path is ported from green-card-guide's src/services/llm-provider.js
 * (service-account OAuth via google-auth-library, cached token, same Gemini IDs).
 *
 * Env (see .env.example):
 *   ANTHROPIC_API_KEY              Claude key
 *   ANTHROPIC_MODEL               optional; default claude-opus-4-8 (claude-haiku-4-5 = faster/cheaper)
 *   GOOGLE_VERTEX_PROJECT          GCP project id (with credits)
 *   GOOGLE_VERTEX_LOCATION         region, default us-central1 (or 'global')
 *   GOOGLE_VERTEX_CREDENTIALS      service-account JSON (raw or base64) — OR —
 *   GOOGLE_APPLICATION_CREDENTIALS path to the SA JSON file (ADC)
 *   GEMINI_API_KEY                 Developer API key (NOT GCP credits)
 *   GEMINI_MODEL                   optional Gemini model override
 *   LLM_PROVIDER                   optional: claude | vertex | developer (force one)
 */

const VERTEX_PROJECT  = process.env.GOOGLE_VERTEX_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || null;
const VERTEX_LOCATION = process.env.GOOGLE_VERTEX_LOCATION || 'us-central1';

// Gemini models: primary first, then graceful fallbacks (tried in order on HTTP failure).
const MODELS = [...new Set(
  (process.env.GEMINI_MODEL ? [process.env.GEMINI_MODEL] : []).concat(['gemini-2.5-flash', 'gemini-2.0-flash'])
)];

// --- Claude (official Anthropic SDK) ---
// Default model per Anthropic best practice; override with ANTHROPIC_MODEL
// (e.g. claude-haiku-4-5 for a faster, cheaper demo).
const Anthropic = require('@anthropic-ai/sdk');
const CLAUDE_MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-4-8';
let _anthropic = null;
function anthropicClient() {
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _anthropic;
}

/* ---------------- provider resolution ---------------- */
function vertexCredentials() {
  const raw = process.env.GOOGLE_VERTEX_CREDENTIALS;
  if (!raw) return null;                         // null -> google-auth-library uses ADC
  try { return JSON.parse(raw); }
  catch {
    try { return JSON.parse(Buffer.from(raw, 'base64').toString('utf8')); }
    catch { return null; }
  }
}
function vertexConfigured() {
  return !!VERTEX_PROJECT &&
    (!!process.env.GOOGLE_VERTEX_CREDENTIALS || !!process.env.GOOGLE_APPLICATION_CREDENTIALS);
}
function developerConfigured() { return !!process.env.GEMINI_API_KEY; }
function claudeConfigured()    { return !!process.env.ANTHROPIC_API_KEY; }

function activeProvider() {
  const forced = (process.env.LLM_PROVIDER || '').toLowerCase();
  if (forced === 'claude'    && claudeConfigured())    return 'claude';
  if (forced === 'vertex'    && vertexConfigured())    return 'vertex';
  if (forced === 'developer' && developerConfigured()) return 'developer';
  // Auto: Claude (ready now) → Vertex (GCP credits) → Developer API.
  if (claudeConfigured())    return 'claude';
  if (vertexConfigured())    return 'vertex';
  if (developerConfigured()) return 'developer';
  return 'none';
}

/* ---------------- Vertex OAuth token (cached ~50m) — from green-card-guide ---------------- */
let _auth = null, _token = null, _tokenExp = 0;
async function vertexAccessToken() {
  const now = Date.now();
  if (_token && now < _tokenExp) return _token;
  if (!_auth) {
    const { GoogleAuth } = require('google-auth-library');
    const creds = vertexCredentials();
    _auth = new GoogleAuth({
      scopes: 'https://www.googleapis.com/auth/cloud-platform',
      ...(creds ? { credentials: creds } : {})   // else falls back to ADC
    });
  }
  const client = await _auth.getClient();
  const tok = await client.getAccessToken();
  _token = (tok && tok.token) || null;
  _tokenExp = now + 50 * 60 * 1000;
  return _token;
}

/* ---------------- Gemini request building (shared by Vertex + Developer) ---------------- */
function vertexUrl(model) {
  const host = VERTEX_LOCATION === 'global'
    ? 'aiplatform.googleapis.com'
    : `${VERTEX_LOCATION}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${VERTEX_PROJECT}/locations/${VERTEX_LOCATION}/publishers/google/models/${model}:generateContent`;
}
function developerUrl(model) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`;
}
function buildGeminiBody(prompt, schema, temperature) {
  return {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: schema,
      temperature: typeof temperature === 'number' ? temperature : 0.7,
      thinkingConfig: { thinkingBudget: 0 }
    }
  };
}
function extractGeminiJSON(data) {
  const text = (data?.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
  if (!text.trim()) throw new Error('empty model response');
  return JSON.parse(text);
}

async function callVertex(prompt, schema, temperature) {
  const token = await vertexAccessToken();
  if (!token) throw new Error('could not mint Vertex OAuth token — check the service account / project');
  let lastErr;
  for (const model of MODELS) {
    try {
      const res = await fetch(vertexUrl(model), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(buildGeminiBody(prompt, schema, temperature))
      });
      if (!res.ok) { lastErr = new Error(`vertex ${model}: HTTP ${res.status} ${(await res.text()).slice(0, 180)}`); continue; }
      return { provider: 'vertex', model, plan: extractGeminiJSON(await res.json()) };
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('vertex: all models failed');
}
async function callDeveloper(prompt, schema, temperature) {
  let lastErr;
  for (const model of MODELS) {
    try {
      const res = await fetch(developerUrl(model), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildGeminiBody(prompt, schema, temperature))
      });
      if (!res.ok) { lastErr = new Error(`developer ${model}: HTTP ${res.status} ${(await res.text()).slice(0, 180)}`); continue; }
      return { provider: 'developer', model, plan: extractGeminiJSON(await res.json()) };
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('developer: all models failed');
}

/* ---------------- Claude (Anthropic SDK) ---------------- */
// The frontend sends a Gemini-style schema (TYPE in UPPERCASE). Convert it to
// standard JSON Schema for Claude's tool input_schema.
function toJsonSchema(node) {
  if (Array.isArray(node)) return node.map(toJsonSchema);
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === 'type' && typeof v === 'string') out.type = v.toLowerCase();
    else if (k === 'properties') {
      out.properties = {};
      for (const [pk, pv] of Object.entries(v)) out.properties[pk] = toJsonSchema(pv);
    } else if (k === 'items') out.items = toJsonSchema(v);
    else if (k === 'propertyOrdering') continue; // not a JSON Schema keyword
    else out[k] = v;
  }
  return out;
}

async function callClaude(prompt, schema, opts = {}) {
  const client = anthropicClient();
  // ANTHROPIC_MODEL (if set) is a hard override; otherwise honor the per-call model
  // the route picked (fast for chat/next-action, smart for analysis), else the default.
  const model = process.env.ANTHROPIC_MODEL || opts.model || CLAUDE_MODEL;
  // Forced tool use = reliable structured output across every Claude model.
  // NOTE: no `temperature` — it 400s on Opus 4.8 / 4.7. Steer via the prompt.
  const msg = await client.messages.create({
    model,
    max_tokens: opts.maxTokens || 4096,   // tight ceilings per route keep latency + cost down
    tools: [{
      name: 'emit_structured_output',
      description: 'Return the result as JSON matching the provided schema.',
      input_schema: toJsonSchema(schema)
    }],
    tool_choice: { type: 'tool', name: 'emit_structured_output' },
    messages: [{ role: 'user', content: prompt }]
  });
  const tool = (msg.content || []).find(b => b.type === 'tool_use');
  if (!tool) throw new Error('claude: model returned no structured output');
  return { provider: 'claude', model, plan: tool.input };
}

/* ---------------- public API ---------------- */
async function generatePlan(prompt, schema, opts = {}) {
  const p = activeProvider();
  if (p === 'claude')    return callClaude(prompt, schema, opts);
  if (p === 'vertex')    return callVertex(prompt, schema, opts.temperature);
  if (p === 'developer') return callDeveloper(prompt, schema, opts.temperature);
  throw new Error('No LLM provider configured. Set ANTHROPIC_API_KEY (Claude), Vertex creds (GCP credits), or GEMINI_API_KEY in .env — see README.');
}

/** Health/status for the frontend badge. */
function status() {
  const p = activeProvider();
  const model = p === 'claude' ? CLAUDE_MODEL
              : (p === 'vertex' || p === 'developer') ? MODELS[0]
              : null;
  return {
    provider: p,                       // 'claude' | 'vertex' | 'developer' | 'none'
    usesGcpCredits: p === 'vertex',
    model,
    project: p === 'vertex' ? VERTEX_PROJECT : null,
    location: p === 'vertex' ? VERTEX_LOCATION : null
  };
}

module.exports = {
  generatePlan, status, activeProvider,
  claudeConfigured, vertexConfigured, developerConfigured,
  toJsonSchema   // exported for self-tests
};
