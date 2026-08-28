'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { captureAgentTask, resolveCapturedTask: resolveAgentTask, runProcess, SCHEMA } = require('../core/agent-task');

const LEGACY_SCHEMA = 'agent-integrity-guard/codex-task';

function toLegacyArtifact(artifact) {
  artifact.schema = LEGACY_SCHEMA;
  artifact.passport.memoryId = artifact.passport.memoryId.replace(/^agent-task-/, 'codex-task-');
  for (const event of artifact.passport.history) event.memoryId = artifact.passport.memoryId;
  artifact.passport.current.memoryId = artifact.passport.memoryId;
  artifact.passport.timeline = artifact.passport.timeline.map((event) => ({ ...event }));
  for (const record of artifact.resultStore) {
    if (record.agentId === 'agent-task-runner') record.agentId = 'codex-task-runner';
    if (record.event.kind === 'runner_verification') {
      record.event.checks.codexExit = record.event.checks.agentExit;
      delete record.event.checks.agentExit;
    }
  }
  artifact.process.codex = artifact.process.agent;
  delete artifact.process.agent;
  return artifact;
}

async function captureCodexTask(options = {}) {
  const artifact = await captureAgentTask({ ...options, agentId: 'codex', handoffKind: 'codex_handoff',
    run: ({ cwd, prompt }) => runProcess('codex', ['exec', '--approve-for-me', '--json', '-C', cwd, prompt], cwd) });
  return toLegacyArtifact(artifact);
}

function resolveCapturedTask(options = {}) {
  return resolveAgentTask({ ...options, acceptedSchemas: [SCHEMA, LEGACY_SCHEMA] });
}

async function main(argv) {
  if (argv[0] === 'run') {
    const [cwd, taskId, prompt, outputPath, ...options] = argv.slice(1);
    const destination = path.resolve(outputPath || `${taskId}.guard.json`);
    const allowedPaths = options.filter((value) => value.startsWith('--allow=')).map((value) => value.slice('--allow='.length));
    if (options.some((value) => !value.startsWith('--allow='))) throw new Error('usage: unknown run option');
    const artifact = await captureCodexTask({ cwd, taskId, prompt, artifactPath: destination, ...(allowedPaths.length ? { allowedPaths } : {}) });
    await fsp.writeFile(destination, `${JSON.stringify(artifact, null, 2)}\n`);
    console.log(JSON.stringify({ ok: artifact.task.status === 'awaiting_review', taskId, taskStatus: artifact.task.status, reviewRequired: artifact.review.required, artifact: destination }));
    return;
  }
  if (argv[0] === 'resolve') {
    const [artifactPath, decision, reason, outputPath] = argv.slice(1);
    const artifact = await resolveCapturedTask({ artifactPath, decision, reason });
    await fsp.writeFile(path.resolve(outputPath || artifactPath), `${JSON.stringify(artifact, null, 2)}\n`);
    console.log(JSON.stringify({ ok: true, taskId: artifact.taskId, decision, taskStatus: artifact.task.status, reviewRequired: artifact.review.required }));
    return;
  }
  throw new Error('usage: guard-codex-task.js run <cwd> <taskId> <prompt> [artifact] [--allow=relative/path]... | resolve <artifact> <decision> <reason> [output]');
}

if (require.main === module) main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });

module.exports = { captureAgentTask, captureCodexTask, resolveCapturedTask };
