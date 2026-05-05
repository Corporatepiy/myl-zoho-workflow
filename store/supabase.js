'use strict';

const { supabase } = require('../config');

// ─────────────────────────────────────────────
// PANEL ACCOUNTS
// ─────────────────────────────────────────────

async function createPanelAccount({ email, name, tier, credit }) {
  const { data, error } = await supabase
    .from('panel_accounts')
    .upsert(
      {
        email,
        name,
        tier,
        credit_balance: credit,
        credit_loaded:  credit,
        status:         'active',
        onboarded_at:   new Date().toISOString(),
      },
      { onConflict: 'email' },
    )
    .select()
    .single();
  if (error) throw new Error('Panel create failed: ' + error.message);
  return data;
}

async function getPanelAccount(email) {
  const { data } = await supabase
    .from('panel_accounts')
    .select('*')
    .eq('email', email)
    .single();
  return data || null;
}

// ─────────────────────────────────────────────
// CALLS
// ─────────────────────────────────────────────

async function insertCall({ call_id, duration_seconds, outcome, transcript, enrichment = {} }) {
  const { error } = await supabase.from('calls').upsert({
    call_id,
    duration_seconds,
    outcome,
    transcript,
    pain_points:            enrichment.pain_points            || [],
    buying_signals:         enrichment.buying_signals         || [],
    objections:             enrichment.objections             || [],
    next_step:              enrichment.next_step              || null,
    lead_score:             enrichment.lead_score             || 0,
    lead_quality:           enrichment.lead_quality           || null,
    founder_stage:          enrichment.founder_stage          || null,
    garment_category:       enrichment.garment_category       || null,
    design_readiness:       enrichment.design_readiness       || null,
    validation_appetite:    enrichment.validation_appetite    || null,
    journey_stage_revenue:  enrichment.journey_stage_revenue  || null,
    recommended_onboarding: enrichment.recommended_onboarding || null,
    summary:                enrichment.summary                || null,
    cofounder_note:         enrichment.cofounder_note         || null,
    created_at:             new Date().toISOString(),
  });
  if (error) {
    console.error('[store] insertCall failed:', error.message, error.details || '');
    throw error;
  }
}

async function getRecentCalls(limit = 50) {
  const { data, error } = await supabase
    .from('calls')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return data;
}

// ─────────────────────────────────────────────
// BLUEPRINTS — stored when generated so the webhook can reference them
// ─────────────────────────────────────────────

async function storeBlueprint({ email, blueprint }) {
  const { error } = await supabase.from('blueprints').upsert(
    { email, blueprint, generated_at: new Date().toISOString() },
    { onConflict: 'email' },
  );
  if (error) console.warn('[store] storeBlueprint failed:', error.message);
}

async function getBlueprint(email) {
  const { data } = await supabase
    .from('blueprints')
    .select('blueprint')
    .eq('email', email)
    .single();
  return data?.blueprint || null;
}

// ─────────────────────────────────────────────
// PATTERNS — aggregated intelligence from past calls
// ─────────────────────────────────────────────

async function getSimilarCalls({ category = 'all', stage = 'all', limit = 60 } = {}) {
  let query = supabase
    .from('calls')
    .select('founder_stage, garment_category, lead_quality, lead_score, buying_signals, pain_points, objections, summary, cofounder_note')
    .not('lead_quality', 'is', null)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (stage    !== 'all') query = query.eq('founder_stage',    stage);
  if (category !== 'all') query = query.eq('garment_category', category);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data || [];
}

async function getLatestPattern({ category = 'all', stage = 'all' } = {}) {
  const { data } = await supabase
    .from('call_patterns')
    .select('content, call_count, generated_at')
    .eq('category', category)
    .eq('stage',    stage)
    .order('generated_at', { ascending: false })
    .limit(1)
    .single();
  return data || null;
}

async function storePattern({ category, stage, content, call_count }) {
  const { error } = await supabase.from('call_patterns').upsert(
    { category, stage, content, call_count, generated_at: new Date().toISOString() },
    { onConflict: 'category,stage' },
  );
  if (error) console.warn('[store] storePattern failed:', error.message);
}

module.exports = {
  createPanelAccount, getPanelAccount,
  insertCall, getRecentCalls,
  storeBlueprint, getBlueprint,
  getSimilarCalls, getLatestPattern, storePattern,
};
