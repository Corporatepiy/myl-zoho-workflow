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
    design_readiness:       enrichment.design_readiness       || null,
    validation_appetite:    enrichment.validation_appetite    || null,
    journey_stage_revenue:  enrichment.journey_stage_revenue  || null,
    recommended_onboarding: enrichment.recommended_onboarding || null,
    summary:                enrichment.summary                || null,
    cofounder_note:         enrichment.cofounder_note         || null,
    created_at:             new Date().toISOString(),
  });
  if (error) console.warn('[store] insertCall failed:', error.message);
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

module.exports = { createPanelAccount, getPanelAccount, insertCall, getRecentCalls, storeBlueprint, getBlueprint };
