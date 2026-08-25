'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { MemoryPassport } = require('../memory-passport');
const { relayExternalResult } = require('../relay');
const { ResultStore } = require('../result-store');

const VERSION = 2;
const SCHEMA = 'agent-integrity-guard/codex-task';
const DECISIONS = new Set(['accepted', 'rejected', 'changes_requested', 'inconclusive']);

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
    child.stdin.end(input);
  });
}

const git = (cwd, args) => runProcess('git', args, cwd);

function hashParts(parts) {
  const hash = createHash('sha256');
  for (const part of parts) {
    const value = Buffer.isBuffer(part) ? part : Buffer.from(String(part));
    hash.update(`${value.length}\0`);
    hash.update(value);
  }
  return hash.digest('hex');
}

async function revisionFingerprint(cwd, ignoredPath) {
  const ignoredAbsolute = ignoredPath && path.resolve(ignoredPath);
  const ignoredRelative = ignoredAbsolute && ignoredAbsolute.startsWith(`${cwd}${path.sep}`) ? path.relative(cwd, ignoredAbsolute) : null;
  const head = await git(cwd, ['rev-parse', '--verify', 'HEAD']);
  if (head.code !== 0 && !/unknown revision|Needed a single revision|ambiguous argument|bad revision/i.test(head.stderr)) throw new Error(`cannot capture HEAD: ${head.stderr.trim()}`);
  const index = await git(cwd, ['write-tree']);
  if (index.code !== 0) throw new Error(`cannot capture index: ${index.stderr.trim()}`);
  const worktreeArgs = ['diff', '--binary'];
  if (ignoredRelative) worktreeArgs.push('--', '.', `:(exclude)${ignoredRelative}`);
  const worktree = await git(cwd, worktreeArgs);
  if (worktree.code !== 0) throw new Error(`cannot capture worktree: ${worktree.stderr.trim()}`);
  const listed = await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (listed.code !== 0) throw new Error(`cannot capture untracked files: ${listed.stderr.trim()}`);
  const untrackedParts = [];
  for (const relative of listed.stdout.split('\0').filter(Boolean).sort()) {
    const absolute = path.resolve(cwd, relative);
    if (!absolute.startsWith(`${cwd}${path.sep}`)) throw new Error(`invalid untracked path: ${relative}`);
    if (ignoredAbsolute && absolute === ignoredAbsolute) continue;
    const stat = await fsp.lstat(absolute);
    untrackedParts.push(relative, stat.isSymbolicLink() ? `symlink:${await fsp.readlink(absolute)}` : await fsp.readFile(absolute));
  }
  const components = {
    head: head.code === 0 ? head.stdout.trim() : null,
    index: index.stdout.trim(),
    worktree: hashParts([worktree.stdout]),
    untracked: hashParts(untrackedParts)
  };
  return { algorithm: 'sha256', value: hashParts([components.head || 'unborn', components.index, components.worktree, components.untracked]), components };
}

function validateArtifact(artifact) {
  if (!artifact || typeof artifact !== 'object' || artifact.version !== VERSION || artifact.schema !== SCHEMA) throw new Error(`unsupported artifact version or schema (expected version ${VERSION})`);
  nonEmpty(artifact.taskId, 'artifact.taskId'); nonEmpty(artifact.cwd, 'artifact.cwd');
  if (!artifact.revision || artifact.revision.algorithm !== 'sha256' || typeof artifact.revision.value !== 'string') throw new TypeError('artifact.revision is invalid');
  const reviewOpen = artifact.review && artifact.review.required === true && (
    artifact.review.status === 'pending' && artifact.review.decision === null
    || artifact.review.status === 'completed' && ['changes_requested', 'inconclusive'].includes(artifact.review.decision)
  );
  if (!reviewOpen) throw new TypeError('artifact.review is not open for another review');
  if (!artifact.task || typeof artifact.task.status !== 'string') throw new TypeError('artifact.task is invalid');
  if (!artifact.passport || typeof artifact.passport !== 'object') throw new TypeError('artifact.passport is invalid');
  const memoryId = nonEmpty(artifact.passport.memoryId, 'artifact.passport.memoryId');
  const history = artifact.passport.history;
  if (!Array.isArray(history) || history.length < 1) throw new TypeError('artifact passport history is invalid');
  const event = history[0];
  if (!event || event.memoryId !== memoryId || event.seq !== 1 || event.eventType !== 'create' || !event.payload || typeof event.payload !== 'object') throw new TypeError('artifact passport create event is invalid');
  nonEmpty(event.eventId, 'passport.history[0].eventId'); nonEmpty(event.timestamp, 'passport.history[0].timestamp'); nonEmpty(event.actorAgentId, 'passport.history[0].actorAgentId');
  for (let index = 0; index < history.length; index += 1) {
    const current = history[index];
    if (!current || current.memoryId !== memoryId || current.seq !== index + 1 || !nonEmpty(current.eventId, `passport.history[${index}].eventId`) || !nonEmpty(current.timestamp, `passport.history[${index}].timestamp`) || !nonEmpty(current.actorAgentId, `passport.history[${index}].actorAgentId`)) throw new TypeError('artifact passport history sequence is invalid');
  }
  if (history.length > 1 && history[history.length - 1].eventType !== 'resolve') throw new TypeError('artifact passport history must end at a resolution');
  for (let index = 1; index < history.length; index += 1) {
    const current = history[index];
    const expected = index % 2 === 1 ? 'review' : 'resolve';
    if (current.eventType !== expected || !current.payload || typeof current.payload !== 'object') throw new TypeError('artifact passport history lifecycle is invalid');
    if (current.eventType === 'resolve' && !DECISIONS.has(current.payload.decision)) throw new TypeError('artifact passport history contains an invalid decision');
  }
}

function makeTimeline(history) {
  return history.map((event) => ({
    seq: event.seq, eventId: event.eventId, timestamp: event.timestamp, actorAgentId: event.actorAgentId, eventType: event.eventType,
    summary: event.eventType === 'create' ? 'Created memory' : event.eventType === 'review' ? 'Requested review' : `Resolved dispute: ${event.payload.decision}`,
    ...(event.payload.reason ? { reason: event.payload.reason } : {}),
    ...(event.eventType === 'resolve' ? { decision: event.payload.decision } : {}),
    sourceProvided: Object.hasOwn(event.payload, 'source'), statusAfter: event.eventType === 'create' ? 'active' : event.eventType === 'review' ? 'disputed' : 'resolved'
  }));
}

async function captureCodexTask({ cwd, taskId, prompt, reviewAgentId = 'reviewer', test = true, artifactPath } = {}) {
  nonEmpty(cwd, 'cwd'); nonEmpty(taskId, 'taskId'); nonEmpty(prompt, 'prompt'); nonEmpty(reviewAgentId, 'reviewAgentId');
  if (reviewAgentId === 'codex') throw new TypeError('reviewAgentId must be independent from codex');
  const root = path.resolve(cwd);
  const baseRevision = await revisionFingerprint(root, artifactPath);
  const before = await git(root, ['status', '--short']);
  const codex = await runProcess('codex', ['exec', '--approve-for-me', '--json', '-C', root, prompt], root);
  const after = await git(root, ['status', '--short']);
  const diffCheck = await git(root, ['diff', '--check']);
  const tests = test ? await runProcess('npm', ['test'], root) : { code: 0, stdout: '', stderr: '', skipped: true };
  const revision = await revisionFingerprint(root, artifactPath);
  const store = new ResultStore();
  const handoff = relayExternalResult({ agentId: 'codex', result: { taskId, exitCode: codex.code, signal: codex.signal, stdout: codex.stdout, stderr: codex.stderr } });
  const handoffEvent = store.append('codex', { kind: 'codex_handoff', result: handoff, statusBefore: before.stdout, statusAfter: after.stdout });
  const verification = store.append('codex-task-runner', { kind: 'runner_verification', checks: { codexExit: codex.code === 0, gitDiffCheck: diffCheck.code === 0, tests: tests.skipped ? 'skipped' : tests.code === 0 }, testOutput: tests.stdout, diffCheckOutput: diffCheck.stderr || diffCheck.stdout, statusAfter: after.stdout });
  store.append('codex-task-runner', { kind: 'review_request', requestedReviewerAgentId: reviewAgentId, reviewedRevision: revision.value });
  const passport = new MemoryPassport();
  const memoryId = `codex-task-${taskId}`;
  passport.create({ memoryId, actorAgentId: 'codex', content: { taskId, status: codex.code === 0 ? 'ready_for_review' : 'execution_failed' }, source: { resultSequence: handoffEvent.sequence, kind: 'codex_handoff' } });
  return {
    version: VERSION, schema: SCHEMA, taskId, cwd: root, baseRevision, revision, resultStore: store.readAll(),
    passport: { memoryId, history: passport.history(memoryId), current: passport.current(memoryId), timeline: passport.timeline(memoryId) },
    process: { codex, tests, diffCheck },
    review: { required: true, status: 'pending', decision: null, requestedReviewerAgentId: reviewAgentId, runnerVerificationSequence: verification.sequence },
    task: { status: codex.code === 0 ? 'awaiting_review' : 'execution_failed' }, reviewRequired: true
  };
}

async function resolveCapturedTask({ artifactPath, decision, adjudicatorAgentId = 'reviewer', reason, content } = {}) {
  nonEmpty(artifactPath, 'artifactPath'); nonEmpty(decision, 'decision'); nonEmpty(adjudicatorAgentId, 'adjudicatorAgentId'); nonEmpty(reason, 'reason');
  if (!DECISIONS.has(decision)) throw new TypeError(`decision must be one of: ${[...DECISIONS].join(', ')}`);
  const artifact = JSON.parse(await fsp.readFile(path.resolve(artifactPath), 'utf8'));
  validateArtifact(artifact);
  const currentRevision = await revisionFingerprint(path.resolve(artifact.cwd), path.resolve(artifactPath));
  if (currentRevision.value !== artifact.revision.value) throw new Error(`revision mismatch: reviewed ${artifact.revision.value}, current ${currentRevision.value}`);
  const history = structuredClone(artifact.passport.history);
  const memoryId = artifact.passport.memoryId;
  if (adjudicatorAgentId === history[0].actorAgentId) throw new TypeError('adjudicatorAgentId must be independent from task agent');
  const nextSeq = history.length + 1;
  const reviewEvent = { eventId: randomUUID(), memoryId, seq: nextSeq, eventType: 'review', actorAgentId: adjudicatorAgentId, timestamp: new Date().toISOString(), payload: { reason, source: { kind: 'review_evidence', revision: artifact.revision.value } } };
  history.push(reviewEvent);
  const resolveSource = { kind: 'review_evidence', reviewEventId: reviewEvent.eventId, revision: artifact.revision.value };
  const resolvePayload = { reason, decision, source: resolveSource, ...(content === undefined ? {} : { content: structuredClone(content) }) };
  const resolveEvent = { eventId: randomUUID(), memoryId, seq: nextSeq + 1, eventType: 'resolve', actorAgentId: adjudicatorAgentId, timestamp: new Date().toISOString(), payload: resolvePayload };
  history.push(resolveEvent);
  const finalOutcome = decision === 'accepted' || decision === 'rejected';
  artifact.passport.history = history;
  artifact.passport.timeline = makeTimeline(history);
  artifact.passport.current = { memoryId, status: 'resolved', content: content === undefined ? structuredClone(history[0].payload.content) : structuredClone(content), createdByAgentId: history[0].actorAgentId, lastEventId: resolveEvent.eventId, seq: resolveEvent.seq, resolution: { adjudicatorAgentId, reason, decision }, source: structuredClone(resolveSource) };
  artifact.review = { ...artifact.review, required: !finalOutcome, status: 'completed', decision, reviewerAgentId: adjudicatorAgentId, evidence: { reason, revision: artifact.revision.value, eventId: reviewEvent.eventId } };
  artifact.task = { ...artifact.task, status: decision };
  artifact.reviewRequired = !finalOutcome;
  return artifact;
}

async function main(argv) {
  const mode = argv[0];
  if (mode === 'run') {
    const [cwd, taskId, prompt, outputPath] = argv.slice(1);
    const destination = path.resolve(outputPath || `${taskId}.guard.json`);
    const artifact = await captureCodexTask({ cwd, taskId, prompt, artifactPath: destination });
    await fsp.writeFile(destination, `${JSON.stringify(artifact, null, 2)}\n`);
    console.log(JSON.stringify({ ok: true, taskId, reviewRequired: true, artifact: destination })); return;
  }
  if (mode === 'resolve') {
    const [artifactPath, decision, reason, outputPath] = argv.slice(1);
    const artifact = await resolveCapturedTask({ artifactPath, decision, reason });
    await fsp.writeFile(path.resolve(outputPath || artifactPath), `${JSON.stringify(artifact, null, 2)}\n`);
    console.log(JSON.stringify({ ok: true, taskId: artifact.taskId, decision, taskStatus: artifact.task.status, reviewRequired: artifact.review.required })); return;
  }
  throw new Error('usage: guard-codex-task.js run <cwd> <taskId> <prompt> [artifact] | resolve <artifact> <accepted|rejected|changes_requested|inconclusive> <reason> [output]');
}

if (require.main === module) main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });

module.exports = { captureCodexTask, resolveCapturedTask };
