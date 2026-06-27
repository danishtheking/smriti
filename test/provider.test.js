'use strict';
// Tests for the LLM provider's pure seam — run with `npm test` (Node's built-in runner).
// No network: only the deterministic schema converter and env-driven provider resolution.
const test = require('node:test');
const assert = require('node:assert');
const provider = require('../llm/provider');

test('toJsonSchema lowercases Gemini-style TYPE to JSON Schema type', () => {
  const out = provider.toJsonSchema({ type: 'OBJECT', properties: { a: { type: 'STRING' } } });
  assert.equal(out.type, 'object');
  assert.equal(out.properties.a.type, 'string');
});

test('toJsonSchema recurses into array items and nested object properties', () => {
  const out = provider.toJsonSchema({
    type: 'ARRAY',
    items: { type: 'OBJECT', properties: { b: { type: 'NUMBER' } } }
  });
  assert.equal(out.type, 'array');
  assert.equal(out.items.type, 'object');
  assert.equal(out.items.properties.b.type, 'number');
});

test('toJsonSchema strips propertyOrdering and preserves required', () => {
  const out = provider.toJsonSchema({
    type: 'OBJECT',
    properties: { a: { type: 'STRING' } },
    propertyOrdering: ['a'],
    required: ['a']
  });
  assert.ok(!('propertyOrdering' in out), 'propertyOrdering should be removed');
  assert.deepEqual(out.required, ['a']);
});

test('claudeConfigured reflects ANTHROPIC_API_KEY presence', () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  assert.equal(provider.claudeConfigured(), true);
  delete process.env.ANTHROPIC_API_KEY;
  assert.equal(provider.claudeConfigured(), false);
  if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
});

test('activeProvider prefers claude when its key is set', () => {
  const savedKey = process.env.ANTHROPIC_API_KEY;
  const savedForce = process.env.LLM_PROVIDER;
  delete process.env.LLM_PROVIDER;
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  assert.equal(provider.activeProvider(), 'claude');
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = savedKey;
  if (savedForce !== undefined) process.env.LLM_PROVIDER = savedForce;
});

test('activeProvider returns "none" when nothing is configured', () => {
  const saved = {
    a: process.env.ANTHROPIC_API_KEY, g: process.env.GEMINI_API_KEY,
    vp: process.env.GOOGLE_VERTEX_PROJECT, gc: process.env.GOOGLE_CLOUD_PROJECT,
    f: process.env.LLM_PROVIDER
  };
  delete process.env.ANTHROPIC_API_KEY; delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_VERTEX_PROJECT; delete process.env.GOOGLE_CLOUD_PROJECT;
  delete process.env.LLM_PROVIDER;
  assert.equal(provider.activeProvider(), 'none');
  for (const [k, v] of Object.entries({ ANTHROPIC_API_KEY: saved.a, GEMINI_API_KEY: saved.g, GOOGLE_VERTEX_PROJECT: saved.vp, GOOGLE_CLOUD_PROJECT: saved.gc, LLM_PROVIDER: saved.f })) {
    if (v !== undefined) process.env[k] = v;
  }
});
