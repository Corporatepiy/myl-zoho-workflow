#!/usr/bin/env node
'use strict';

const { Server }               = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');
const https = require('https');
const http  = require('http');

const BASE_URL   = process.env.MYL_SERVER_URL || 'https://myl-zoho-workflow-production.up.railway.app';
const API_SECRET = process.env.API_SECRET      || '';

// ── HTTP helper ────────────────────────────────────────────────
function apiCall(method, path, body = null) {
  const url  = new URL(path, BASE_URL);
  const lib  = url.protocol === 'https:' ? https : http;
  const data = body ? JSON.stringify(body) : null;

  return new Promise((resolve, reject) => {
    const req = lib.request({
      hostname: url.hostname,
      port:     url.port || (url.protocol === 'https:' ? 443 : 80),
      path:     url.pathname + url.search,
      method,
      headers: {
        'Content-Type':  'application/json',
        'x-api-secret':  API_SECRET,
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch { resolve({ raw }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ── Tool definitions ───────────────────────────────────────────
const TOOLS = [
  {
    name:        'myl_server_health',
    description: 'Check MYL Brain server status and version.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name:        'myl_trigger_call',
    description: 'Trigger an outbound Synthflow call to a founder. Creates a Zoho CRM lead and dials immediately. Phone must include country code.',
    inputSchema: {
      type: 'object',
      required: ['name', 'email', 'phone'],
      properties: {
        name:     { type: 'string', description: 'Founder full name' },
        email:    { type: 'string', description: 'Email address' },
        phone:    { type: 'string', description: 'Phone with country code e.g. +447911123456' },
        business: { type: 'string', description: 'Brand or business name' },
        goal:     { type: 'string', description: 'What they want to achieve' },
        category: { type: 'string', description: 'Garment type e.g. dresses, streetwear' },
        market:   { type: 'string', description: 'UK, US, India, or UAE' },
      },
    },
  },
  {
    name:        'myl_dashboard',
    description: 'Get the call insights dashboard — total calls, hot/warm/cold breakdown, average lead score, design-ready count.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name:        'myl_list_recent_leads',
    description: 'List the most recent enriched calls/leads from the database.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max records to return (default 20, max 50)' },
      },
    },
  },
  {
    name:        'myl_get_lead',
    description: 'Look up a lead in Zoho CRM by email address.',
    inputSchema: {
      type: 'object',
      required: ['email'],
      properties: {
        email: { type: 'string', description: 'Lead email address' },
      },
    },
  },
  {
    name:        'myl_update_lead',
    description: 'Update a lead record in Zoho CRM — score, quality, stage, summary, or any enrichment field.',
    inputSchema: {
      type: 'object',
      required: ['email'],
      properties: {
        email:               { type: 'string' },
        leadScore:           { type: 'number', description: '0-100' },
        leadQuality:         { type: 'string', description: 'Hot, Warm, or Cold' },
        callSummary:         { type: 'string' },
        founderStage:        { type: 'string', description: 'IDEA, HAS_DESIGN, HAS_SAMPLE, SELLING, SCALING' },
        designReadiness:     { type: 'string' },
        validationAppetite:  { type: 'string', description: 'HIGH, MEDIUM, or LOW' },
        journeyStageRevenue: { type: 'string' },
      },
    },
  },
  {
    name:        'myl_create_note',
    description: 'Add a co-founder note to a lead in Zoho CRM.',
    inputSchema: {
      type: 'object',
      required: ['email', 'note'],
      properties: {
        email: { type: 'string', description: 'Lead email address' },
        note:  { type: 'string', description: 'Note content' },
      },
    },
  },
  {
    name:        'myl_create_task',
    description: 'Create a follow-up task on a lead in Zoho CRM.',
    inputSchema: {
      type: 'object',
      required: ['email', 'task'],
      properties: {
        email:    { type: 'string', description: 'Lead email address' },
        task:     { type: 'string', description: 'Task description' },
        due_date: { type: 'string', description: 'Due date YYYY-MM-DD (default: 2 days from now)' },
      },
    },
  },
  {
    name:        'myl_get_patterns',
    description: 'Get AI-extracted pattern intelligence for a founder segment — hot signals, objections, conversion framing, co-founder insight.',
    inputSchema: {
      type: 'object',
      properties: {
        stage:    { type: 'string', description: 'Founder stage: IDEA, HAS_DESIGN, HAS_SAMPLE, SELLING, SCALING, or all' },
        category: { type: 'string', description: 'Garment category e.g. dresses, streetwear, or all' },
      },
    },
  },
  {
    name:        'myl_refresh_patterns',
    description: 'Trigger AI pattern extraction from the last 60 calls for a founder segment. Returns immediately with extracted patterns.',
    inputSchema: {
      type: 'object',
      properties: {
        stage:    { type: 'string', description: 'Founder stage or all' },
        category: { type: 'string', description: 'Garment category or all' },
      },
    },
  },
];

// ── Tool handlers ──────────────────────────────────────────────
async function handleTool(name, args) {
  switch (name) {
    case 'myl_server_health':
      return apiCall('GET', '/health');

    case 'myl_trigger_call':
      return apiCall('POST', '/api/intake', args);

    case 'myl_dashboard':
      return apiCall('GET', '/api/call-insights');

    case 'myl_list_recent_leads': {
      const data  = await apiCall('GET', '/api/call-insights');
      const calls = (data.calls || []).slice(0, Math.min(args.limit || 20, 50));
      return { calls, summary: data.summary };
    }

    case 'myl_get_lead':
      return apiCall('GET', `/api/leads?email=${encodeURIComponent(args.email)}`);

    case 'myl_update_lead':
      return apiCall('PATCH', '/api/leads', args);

    case 'myl_create_note':
      return apiCall('POST', '/api/leads/note', args);

    case 'myl_create_task':
      return apiCall('POST', '/api/leads/task', args);

    case 'myl_get_patterns': {
      const p = new URLSearchParams({
        category: args.category || 'all',
        stage:    args.stage    || 'all',
      });
      return apiCall('GET', `/api/call-insights/patterns?${p}`);
    }

    case 'myl_refresh_patterns':
      return apiCall('POST', '/api/call-insights/patterns/refresh', {
        category: args.category || 'all',
        stage:    args.stage    || 'all',
      });

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── Server bootstrap ───────────────────────────────────────────
async function main() {
  const server = new Server(
    { name: 'myl-workflow', version: '2.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const result = await handleTool(name, args || {});
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (e) {
      return {
        content: [{ type: 'text', text: `Error: ${e.message}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
