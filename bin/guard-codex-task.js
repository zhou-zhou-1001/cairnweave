'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { MemoryPassport } = require('../memory-passport');
const { relayExternalResult } = require('../relay');
const { ResultStore } = require('../result-store');

function nonEmpty(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} must be non-empty`);
  return value;
}

function runProcess(command, args, cwd, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

async function git(cwd, args) {
  return runProcess('git', args, cwd);
}

async function captureCodexTask({ cwd, taskId, prompt, reviewAgentId = 'reviewer', test = true } = {}) {
  nonEmpty(cwd, 'cwd');
  nonEmpty(taskId, 'taskId');
  nonEmpty(prompt, 'prompt');
  nonEmpty(reviewAgentId, 'reviewAgentId');
  const root = path.resolve(cwd);
  const before = await git(root, ['status', '--short']);
  const codex = await runProcess('codex', ['exec', '--approve-for-me', '--json', '-C', root, prompt], root);
  const after = await git(root, ['status', '--short']);
  const diffCheck = await git(root, ['diff', '--check']);
  const tests = test ? await runProcess('npm', ['test'], root) : { code: 0, stdout: '', stderr: '', skipped: true };

  const store = new ResultStore();
  const handoff = relayExternalResult({
    agentId: 'codex',
    result: { taskId, exitCode: codex.code, signal: codex.signal, stdout: codex.stdout, stderr: codex.stderr }
  });
  const handoffEvent = store.append('codex', { kind: 'codex_handoff', result: handoff, statusBefore: before.stdout, statusAfter: after.stdout });
  const verificationEvent = store.append(reviewAgentId, {
    kind: 'verification_evidence',
    checks: {
      codexExit: codex.code === 0,
      gitDiffCheck: diffCheck.code === 0,
      tests: tests.skipped ? 'skipped' : tests.code === 0
    },
    testOutput: tests.stdout,
    diffCheckOutput: diffCheck.stderr || diffCheck.stdout,
    statusAfter: after.stdout
  });

  const passport = new MemoryPassport();
  const memoryId = `codex-task-${taskId}`;
  passport.create({
    memoryId,
    actorAgentId: 'codex',
    content: { taskId, status: codex.code === 0 ? 'ready_for_review' : 'execution_failed' },
    source: { resultSequence: handoffEvent.sequence, kind: 'codex_handoff' }
  });
  passport.requestReview(memoryId, {
    actorAgentId: reviewAgentId,
    reason: 'Independent review required after Codex execution',
    source: { resultSequence: verificationEvent.sequence, kind: 'verification_evidence' }
  });

  return {
    version: 1,
    taskId,
    cwd: root,
    resultStore: store.readAll(),
    passport: { memoryId, history: passport.history(memoryId), current: passport.current(memoryId), timeline: passport.timeline(memoryId) },
    process: { codex, tests, diffCheck },
    reviewRequired: true
  };
}

async function resolveCapturedTask({ artifactPath, decision, adjudicatorAgentId = 'reviewer', reason, content } = {}) {
  nonEmpty(artifactPath, 'artifactPath');
  nonEmpty(decision, 'decision');
  nonEmpty(adjudicatorAgentId, 'adjudicatorAgentId');
  nonEmpty(reason, 'reason');
  const artifact = JSON.parse(await fsp.readFile(path.resolve(artifactPath), 'utf8'));
  const passport = new MemoryPassport();
  const memoryId = artifact.passport.memoryId;
  for (const event of artifact.passport.history) {
    if (event.eventType === 'create') passport.create({ memoryId, actorAgentId: event.actorAgentId, content: event.payload.content, source: event.payload.source });
    else if (event.eventType === 'review') passport.requestReview(memoryId, { actorAgentId: event.actorAgentId, reason: event.payload.reason, source: event.payload.source });
    else if (event.eventType === 'dispute') passport.dispute(memoryId, { actorAgentId: event.actorAgentId, reason: event.payload.reason, source: event.payload.source });
  }
  passport.resolve(memoryId, { adjudicatorAgentId, reason, decision, ...(content === undefined ? {} : { content }) });
  artifact.passport.current = passport.current(memoryId);
  artifact.passport.history = passport.history(memoryId);
  artifact.passport.timeline = passport.timeline(memoryId);
  artifact.reviewRequired = false;
  return artifact;
}

async function main(argv) {
  const mode = argv[0];
  if (mode === 'run') {
    const [cwd, taskId, prompt, outputPath] = argv.slice(1);
    const artifact = await captureCodexTask({ cwd, taskId, prompt });
    await fsp.writeFile(path.resolve(outputPath || `${taskId}.guard.json`), `${JSON.stringify(artifact, null, 2)}\n`);
    console.log(JSON.stringify({ ok: true, taskId, reviewRequired: true, artifact: path.resolve(outputPath || `${taskId}.guard.json`) }));
    return;
  }
  if (mode === 'resolve') {
    const [artifactPath, decision, reason, outputPath] = argv.slice(1);
    const artifact = await resolveCapturedTask({ artifactPath, decision, reason });
    await fsp.writeFile(path.resolve(outputPath || artifactPath), `${JSON.stringify(artifact, null, 2)}\n`);
    console.log(JSON.stringify({ ok: true, taskId: artifact.taskId, decision, status: artifact.passport.current.status }));
    return;
  }
  throw new Error('usage: guard-codex-task.js run <cwd> <taskId> <prompt> [artifact] | resolve <artifact> <decision> <reason> [output]');
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { captureCodexTask, resolveCapturedTask };
