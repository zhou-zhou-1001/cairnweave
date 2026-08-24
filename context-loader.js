'use strict';

const BASE_CONTEXT_FILES = Object.freeze([
  'AGENTS.md',
  'SOUL.md',
  'USER.md'
]);

const SUPPORTED_PROMPT_MODES = new Set(['default', 'compact', 'worker']);

async function loadBaseContext({ promptMode = 'default', readFile }) {
  if (!SUPPORTED_PROMPT_MODES.has(promptMode)) {
    throw new RangeError(`Unsupported promptMode: ${promptMode}`);
  }
  if (typeof readFile !== 'function') {
    throw new TypeError('readFile must be a function');
  }

  return Promise.all(BASE_CONTEXT_FILES.map(async (filename) => ({
    filename,
    content: await readFile(filename)
  })));
}

module.exports = { BASE_CONTEXT_FILES, loadBaseContext };
