-- Run this once in the Supabase SQL editor

create table if not exists calls (
  id                     uuid default gen_random_uuid() primary key,
  call_id                text unique,
  duration_seconds       int,
  outcome                text,
  transcript             text,
  pain_points            jsonb,
  buying_signals         jsonb,
  objections             jsonb,
  next_step              text,
  lead_score             int,
  lead_quality           text,
  founder_stage          text,
  design_readiness       text,
  validation_appetite    text,
  journey_stage_revenue  text,
  recommended_onboarding text,
  summary                text,
  cofounder_note         text,
  created_at             timestamptz default now()
);

create table if not exists panel_accounts (
  id             uuid default gen_random_uuid() primary key,
  email          text unique not null,
  name           text,
  tier           text,
  credit_balance numeric default 0,
  credit_loaded  numeric default 0,
  status         text default 'active',
  onboarded_at   timestamptz default now()
);

create table if not exists blueprints (
  id           uuid default gen_random_uuid() primary key,
  email        text unique not null,
  blueprint    jsonb,
  generated_at timestamptz default now()
);

create table if not exists credit_transactions (
  id            uuid default gen_random_uuid() primary key,
  email         text not null,
  amount        numeric,
  description   text,
  balance_after numeric,
  created_at    timestamptz default now()
);
