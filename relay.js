'use strict';

const RELAY_FIELDS = Object.freeze(['agentId', 'result', 'url', 'model']);

function relayExternalResult(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('input must be an object');
  }
  if (!Object.hasOwn(input, 'agentId') ||
      typeof input.agentId !== 'string' || input.agentId.trim().length === 0) {
    throw new TypeError('input.agentId must be an explicitly supplied non-empty string');
  }
  if (!Object.hasOwn(input, 'result')) {
    throw new TypeError('input.result must be explicitly supplied');
  }

  const relayed = {};
  for (const field of RELAY_FIELDS) {
    if (Object.hasOwn(input, field)) {
      relayed[field] = structuredClone(input[field]);
    }
  }
  return relayed;
}

module.exports = { relayExternalResult };
