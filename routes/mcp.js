'use strict';

// Remote HTTP MCP endpoint — lets claude.ai web connect to MYL tools.
// Auth: Authorization: Bearer <API_SECRET>
//
// Connected at claude.ai → Settings → Integrations → MYLENGINE
// URL: https://myl-zoho-workflow-production.up.railway.app/mcp

const router = require('express').Router();
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');
const { TOOLS, handleTool } = require('../lib/mcp-core');

// ── Resources: browseable content in claude.ai ─────────────────
// These let users click through to read content without knowing which tool to call.
const RESOURCES = [
  {
    uri:         'synthflow://agent/script',
    name:        "Alex's Calling Script",
    description: 'Full Synthflow voice agent prompt — every phase, rule, and tool instruction Alex follows on every call. Read this to audit or train the script.',
    mimeType:    'text/plain',
  },
  {
    uri:         'synthflow://agent/actions',
    name:        'Agent Tool Actions (5)',
    description: 'The 5 mid-call tool actions the voice agent can fire: get_brand_blueprint, consult_brain, send_brand_email, tag_prospect, book_consultation.',
    mimeType:    'application/json',
  },
  {
    uri:         'myl://system/architecture',
    name:        'MYL System Architecture',
    description: 'How the whole system is built — intake → voice AI → brain loop → CRM → email → payments. Read this to understand or explain the stack.',
    mimeType:    'application/json',
  },
  {
    uri:         'myl://brain/patterns',
    name:        'Live Pattern Intelligence',
    description: 'AI-extracted patterns from real calls — hot signals, objections, what converts. Updates automatically after every call.',
    mimeType:    'application/json',
  },
];

// ── Prompts: reusable templates for common tasks ───────────────
const PROMPTS = [
  {
    name:        'review_script',
    description: 'Review and suggest improvements to the current Alex calling script',
  },
  {
    name:        'train_objection',
    description: 'Train Alex to handle a specific objection better — provide the objection and ideal response',
    arguments:   [
      { name: 'objection', description: 'The objection founders raise e.g. "I don\'t have budget"', required: true },
      { name: 'ideal_response', description: 'How Alex should ideally respond', required: false },
    ],
  },
  {
    name:        'test_founder_call',
    description: 'Simulate a full call with a specific founder profile and show what blueprint Alex would generate',
    arguments:   [
      { name: 'name',     description: 'Founder name',                        required: true  },
      { name: 'business', description: 'Brand / business name',               required: true  },
      { name: 'category', description: 'Garment category e.g. streetwear',   required: false },
      { name: 'stage',    description: 'IDEA, HAS_DESIGN, HAS_SAMPLE, etc.', required: false },
    ],
  },
];

// ── Build MCP server ───────────────────────────────────────────
function buildMcpServer() {
  const server = new Server(
    { name: 'MYLENGINE', version: '3.0.0' },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );

  // Tools
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const result = await handleTool(name, args || {});
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
    }
  });

  // Resources — browseable content
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: RESOURCES }));
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;

    if (uri === 'synthflow://agent/script') {
      const r = await handleTool('myl_get_agent_script', {});
      return { contents: [{ uri, mimeType: 'text/plain', text: r.prompt || 'No script found' }] };
    }

    if (uri === 'synthflow://agent/actions') {
      const r = await handleTool('myl_get_actions', {});
      return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(r, null, 2) }] };
    }

    if (uri === 'myl://system/architecture') {
      const r = await handleTool('myl_system_overview', {});
      return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(r, null, 2) }] };
    }

    if (uri === 'myl://brain/patterns') {
      const r = await handleTool('myl_get_patterns', {});
      return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(r, null, 2) }] };
    }

    throw new Error(`Unknown resource: ${uri}`);
  });

  // Prompts — reusable task templates
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: PROMPTS }));
  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    if (name === 'review_script') {
      const r = await handleTool('myl_get_agent_script', {});
      return {
        description: 'Review the current Alex calling script and suggest improvements',
        messages: [{
          role: 'user',
          content: {
            type: 'text',
            text: `Here is the current Synthflow voice agent script for Alex at MakeYourLabel:\n\n---\n${r.prompt}\n---\n\nPlease review this script and suggest specific improvements to:\n1. Make the tool-call rules clearer and harder to skip\n2. Improve the opening hook\n3. Strengthen the ask in Phase 6\n4. Make the tone warmer without losing urgency`,
          },
        }],
      };
    }

    if (name === 'train_objection') {
      const r = await handleTool('myl_get_agent_script', {});
      return {
        description: `Train Alex to handle: "${args.objection}"`,
        messages: [{
          role: 'user',
          content: {
            type: 'text',
            text: `Current Alex script:\n\n---\n${r.prompt}\n---\n\nFounders are raising this objection on calls: "${args.objection}"\n${args.ideal_response ? `\nIdeal response we want: "${args.ideal_response}"\n` : ''}\nPlease write an updated version of the relevant section of the script that handles this objection naturally. Then show me the exact patch to apply (old text → new text).`,
          },
        }],
      };
    }

    if (name === 'test_founder_call') {
      return {
        description: `Simulate a call with ${args.name} from ${args.business}`,
        messages: [{
          role: 'user',
          content: {
            type: 'text',
            text: `Use myl_test_blueprint to generate a brand blueprint for this founder:\n- Name: ${args.name}\n- Business: ${args.business}\n- Category: ${args.category || 'not specified'}\n- Stage: ${args.stage || 'IDEA'}\n\nThen show me:\n1. The full blueprint Alex would deliver\n2. The exact words Alex would use to deliver the "reading" section conversationally\n3. The email subject line Alex would use when calling send_brand_email`,
          },
        }],
      };
    }

    throw new Error(`Unknown prompt: ${name}`);
  });

  return server;
}

// ── Auth ───────────────────────────────────────────────────────
// Accepts: Authorization: Bearer <token>  OR  ?key=<token> in URL
function checkAuth(req, res) {
  const header = req.headers['authorization'] || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  const query  = req.query.key || '';
  const token  = bearer || query;
  if (!token || token !== process.env.API_SECRET) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

// ── Routes ─────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  if (!checkAuth(req, res)) return;
  // Inject required Accept headers if claude.ai omits them
  if (!req.headers['accept']) {
    req.headers['accept'] = 'application/json, text/event-stream';
  } else if (!req.headers['accept'].includes('text/event-stream')) {
    req.headers['accept'] += ', text/event-stream';
  }
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server    = buildMcpServer();
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

router.get('/', async (req, res) => {
  if (!checkAuth(req, res)) return;
  // Connectivity probe (no SSE header) — return server info so claude.ai knows we're alive
  if (!req.headers['accept']?.includes('text/event-stream')) {
    return res.json({ name: 'MYLENGINE', version: '3.0.0', status: 'ok', tools: TOOLS.length });
  }
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server    = buildMcpServer();
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

module.exports = router;
