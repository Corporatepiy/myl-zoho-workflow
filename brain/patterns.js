'use strict';

const { anthropic }                             = require('../config');
const { getSimilarCalls, getLatestPattern, storePattern } = require('../store/supabase');

const PATTERN_SYSTEM = `You are a sales intelligence analyst for MakeYourLabel.
Analyse these enriched call records from real founder calls.
Return JSON only — no preamble, no markdown:
{
  "hot_signals":       ["3-5 specific things said/shown by Hot leads that Cold leads don't"],
  "cold_signals":      ["3-5 early warning signs that predict a Cold lead quickly"],
  "common_objections": ["top 3 objections in this segment"],
  "what_converts":     "one sentence: the framing that moves a hesitant founder to engaged",
  "effective_reframes":["2-3 specific phrases that worked well in this segment"],
  "archetype_pattern": "one sentence on brand archetypes dominant in this segment",
  "cofounder_insight": "one sentence Alex should know before any call with this type of founder"
}`;

async function extractPatterns(calls) {
  const summaries = calls.map(c => ({
    stage:      c.founder_stage,
    category:   c.garment_category,
    quality:    c.lead_quality,
    score:      c.lead_score,
    signals:    c.buying_signals,
    pain:       c.pain_points,
    objections: c.objections,
    summary:    c.summary,
    note:       c.cofounder_note,
  }));

  const res = await anthropic.messages.create({
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 800,
    system:     PATTERN_SYSTEM,
    messages:   [{ role: 'user', content: JSON.stringify(summaries) }],
  });

  const text  = res.content[0].text.replace(/```json|```/g, '').trim();
  try { return JSON.parse(text); }
  catch { const m = text.match(/\{[\s\S]*\}/); return m ? JSON.parse(m[0]) : null; }
}

async function shouldRefresh({ category, stage }) {
  const existing = await getLatestPattern({ category, stage }).catch(() => null);
  if (!existing) return true;
  const ageMs = Date.now() - new Date(existing.generated_at).getTime();
  return ageMs > 6 * 60 * 60 * 1000; // refresh if older than 6 hours
}

async function refreshPatterns({ category = 'all', stage = 'all' } = {}) {
  const calls = await getSimilarCalls({ category, stage, limit: 60 });
  if (calls.length < 5) return null;

  const patterns = await extractPatterns(calls);
  if (!patterns) return null;

  await storePattern({ category, stage, content: patterns, call_count: calls.length });
  console.log(`[patterns] refreshed segment ${category}/${stage} from ${calls.length} calls`);
  return patterns;
}

// Returns a ready-to-inject text block, or '' if no data yet.
async function buildContextBlock({ category, stage } = {}) {
  // Try most-specific segment first, fall back to stage-only, then global
  const candidates = [
    category && stage ? { category, stage } : null,
    stage             ? { category: 'all', stage } : null,
    { category: 'all', stage: 'all' },
  ].filter(Boolean);

  let pattern = null;
  for (const seg of candidates) {
    pattern = await getLatestPattern(seg).catch(() => null);
    if (pattern) break;
  }
  if (!pattern) return '';

  const p     = pattern.content;
  const count = pattern.call_count;
  const lines = [`LIVE INTELLIGENCE — patterns from ${count} real calls:`];

  if (p.hot_signals?.length)
    lines.push(`Hot signals: ${p.hot_signals.slice(0, 3).join('; ')}`);
  if (p.common_objections?.length)
    lines.push(`Common objections: ${p.common_objections.slice(0, 3).join('; ')}`);
  if (p.what_converts)
    lines.push(`What converts: ${p.what_converts}`);
  if (p.cofounder_insight)
    lines.push(`Insight: ${p.cofounder_insight}`);

  return lines.join('\n');
}

module.exports = { refreshPatterns, shouldRefresh, buildContextBlock };
