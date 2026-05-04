'use strict';

const axios      = require('axios');
const { SF_BASE } = require('../config');

function getAgentForPhone(phone) {
  if (phone.startsWith('+91')) return process.env.AGENT_IN;
  if (phone.startsWith('+44')) return process.env.AGENT_GB;
  return process.env.AGENT_US;
}

async function triggerCall({ to, agentId, variables = {} }) {
  if (process.env.SANDBOX_MODE === 'true') {
    console.log(`[SANDBOX] triggerCall suppressed → ${to} (${variables.name || 'unknown'})`);
    return { sandbox: true, suppressed: true, to, name: variables.name };
  }
  const res = await axios.post(
    `${SF_BASE}/calls`,
    {
      model_id:          agentId,
      phone:             to,
      name:              `${variables.name || 'Founder'} — MYL call`,
      dynamic_variables: variables,
    },
    {
      headers: {
        Authorization:  `Bearer ${process.env.SYNTHFLOW_API_KEY}`,
        'Content-Type': 'application/json',
      },
    },
  );
  return res.data;
}

module.exports = { getAgentForPhone, triggerCall };
