'use strict';

const { BASE_CONTEXT_FILES, loadBaseContext } = require('./context-loader');
const { MemoryPassport } = require('./memory-passport');
const { relayExternalResult } = require('./relay');
const { ResultStore } = require('./result-store');
const { captureAgentTask, resolveCapturedTask } = require('./core/agent-task');
const { captureCodexTask } = require('./bin/guard-codex-task');
const { captureCommandTask } = require('./bin/guard-agent-task');
const { saveArtifact, loadArtifact } = require('./artifact-store');

module.exports = {
  BASE_CONTEXT_FILES,
  loadBaseContext,
  MemoryPassport,
  relayExternalResult,
  ResultStore,
  captureAgentTask,
  captureCodexTask,
  captureCommandTask,
  resolveCapturedTask,
  saveArtifact,
  loadArtifact
};
