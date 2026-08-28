'use strict';

const fsp = require('node:fs/promises');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { spawn } = require('node:child_process');
const { MemoryPassport } = require('../memory-passport');
const { relayExternalResult } = require('../relay');
const { ResultStore } = require('../result-store');

const VERSION = 2;
const SCHEMA = 'agent-integrity-guard/agent-task';
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

async function changedPaths(cwd, ignoredPath) {
  const result = await git(cwd, ['status', '--porcelain=v1', '-z']);
  if (result.code !== 0) throw new Error(`cannot inspect changed paths: ${result.stderr.trim()}`);
  const ignoredAbsolute = ignoredPath && path.resolve(ignoredPath);
  const paths = new Set();
  for (const entry of result.stdout.split('\0').filter(Boolean)) {
    // Porcelain v1 uses two status columns followed by a space. Renames have
    // an old and new path; the new path is the one that must be in scope.
    const value = entry.slice(3);
    const rename = value.split(' -> ');
    const changed = rename[rename.length - 1];
    if (!ignoredAbsolute || path.resolve(cwd, changed) !== ignoredAbsolute) paths.add(changed);
  }
  return [...paths].sort();
}

function normalizeAllowedPaths(root, allowedPaths) {
  if (allowedPaths === undefined) return null;
  if (!Array.isArray(allowedPaths) || allowedPaths.some((value) => typeof value !== 'string' || value.trim() === '')) {
    throw new TypeError('allowedPaths must be an array of non-empty relative paths');
  }
  return allowedPaths.map((value) => {
    const normalized = path.posix.normalize(value.replaceAll('\\', '/'));
    if (normalized === '.' || normalized.startsWith('../') || normalized.startsWith('/')) {
      throw new TypeError(`allowedPaths must stay inside cwd: ${value}`);
    }
    return normalized;
  }).filter((value, index, values) => values.indexOf(value) === index).sort();
}

function pathAllowed(changed, allowed) {
  return allowed.some((prefix) => changed === prefix || changed.startsWith(`${prefix}/`));
}

function validateRevision(revision, name) {
  if (!revision || revision.algorithm !== 'sha256' || typeof revision.value !== 'string' || !/^[a-f0-9]{64}$/.test(revision.value)) throw new TypeError(`${name} is invalid`);
  const components = revision.components;
  if (!components || (components.head !== null && typeof components.head !== 'string') || typeof components.index !== 'string' || typeof components.worktree !== 'string' || typeof components.untracked !== 'string' || !/^[a-f0-9]{40}$/.test(components.index) || !/^[a-f0-9]{64}$/.test(components.worktree) || !/^[a-f0-9]{64}$/.test(components.untracked)) throw new TypeError(`${name}.components is invalid`);
  if (hashParts([components.head || 'unborn', components.index, components.worktree, components.untracked]) !== revision.value) throw new Error(`${name} components do not match value`);
}

function validateResultStore(artifact) {
  const records = artifact.resultStore;
  if (!Array.isArray(records) || records.length < 3) throw new TypeError('artifact.resultStore is invalid');
  const first = records[0];
  const runnerId = artifact.schema === 'agent-integrity-guard/codex-task' ? 'codex-task-runner' : 'agent-task-runner';
  if (!first || first.sequence !== 1 || first.agentId !== artifact.passport.history[0].actorAgentId || !first.event || first.event.kind !== (artifact.schema === 'agent-integrity-guard/codex-task' ? 'codex_handoff' : 'agent_handoff') || !first.event.result || !first.event.result.result || first.event.result.result.taskId !== artifact.taskId) throw new TypeError('resultStore handoff is inconsistent');
  const verification = records[1];
  if (!verification || verification.sequence !== 2 || verification.agentId !== runnerId || !verification.event || verification.event.kind !== 'runner_verification' || !verification.event.checks || typeof verification.event.checks !== 'object') throw new TypeError('resultStore runner verification is inconsistent');
  const request = records[2];
  if (!request || request.sequence !== 3 || request.agentId !== runnerId || !request.event || request.event.kind !== 'review_request' || request.event.requestedReviewerAgentId !== artifact.review.requestedReviewerAgentId || request.event.reviewedRevision !== artifact.revision.value) throw new TypeError('resultStore review request is inconsistent');
  if (artifact.review.runnerVerificationSequence !== verification.sequence) throw new TypeError('runnerVerificationSequence is inconsistent');
  for (let i = 0; i < records.length; i += 1) if (!records[i] || records[i].sequence !== i + 1 || typeof records[i].agentId !== 'string') throw new TypeError('resultStore sequence is invalid');
}

function validateArtifact(artifact, schemas) {
  if (!artifact || typeof artifact !== 'object' || artifact.version !== VERSION || !schemas.includes(artifact.schema)) throw new Error(`unsupported artifact version or schema (expected version ${VERSION})`);
  nonEmpty(artifact.taskId, 'artifact.taskId'); nonEmpty(artifact.cwd, 'artifact.cwd');
  if (path.resolve(artifact.cwd) !== artifact.cwd) throw new TypeError('artifact.cwd must be absolute and normalized');
  let cwdStat;
  try { cwdStat = fs.statSync(artifact.cwd); } catch { throw new TypeError('artifact.cwd must be an existing directory'); }
  if (!cwdStat.isDirectory()) throw new TypeError('artifact.cwd must be an existing directory');
  validateRevision(artifact.baseRevision, 'artifact.baseRevision');
  validateRevision(artifact.revision, 'artifact.revision');
  if (!artifact.review || typeof artifact.review !== 'object' || !nonEmpty(artifact.review.requestedReviewerAgentId, 'review.requestedReviewerAgentId')) throw new TypeError('artifact.review is invalid');
  if (!artifact.task || typeof artifact.task.status !== 'string') throw new TypeError('artifact.task is invalid');
  if (typeof artifact.reviewRequired !== 'boolean' || artifact.reviewRequired !== artifact.review.required) throw new TypeError('reviewRequired is inconsistent');
  const expectedOpen = artifact.task.status === 'awaiting_review' || artifact.task.status === 'changes_requested' || artifact.task.status === 'inconclusive';
  const reviewOpen = artifact.review.required === true && ((artifact.review.status === 'pending' && artifact.review.decision === null) || (artifact.review.status === 'completed' && ['changes_requested', 'inconclusive'].includes(artifact.review.decision)));
  if (expectedOpen !== reviewOpen) throw new TypeError('artifact.review is inconsistent with task status');
  if (!artifact.passport || typeof artifact.passport !== 'object') throw new TypeError('artifact.passport is invalid');
  const memoryId = nonEmpty(artifact.passport.memoryId, 'artifact.passport.memoryId');
  const history = artifact.passport.history;
  if (!Array.isArray(history) || history.length < 1) throw new TypeError('artifact passport history is invalid');
  const ids = new Set();
  for (let index = 0; index < history.length; index += 1) {
    const current = history[index];
    if (!current || current.memoryId !== memoryId || current.seq !== index + 1 || !nonEmpty(current.eventId, `passport.history[${index}].eventId`) || ids.has(current.eventId) || !nonEmpty(current.timestamp, `passport.history[${index}].timestamp`) || !nonEmpty(current.actorAgentId, `passport.history[${index}].actorAgentId`) || !current.payload || typeof current.payload !== 'object') throw new TypeError('artifact passport history sequence is invalid');
    ids.add(current.eventId);
  }
  const create = history[0];
  if (create.eventType !== 'create' || !isDeepStrictEqual(create.payload.content && create.payload.content.taskId, artifact.taskId) || !create.payload.source || create.payload.source.resultSequence !== 1) throw new TypeError('artifact passport create event is invalid');
  if (history.length > 1 && history[history.length - 1].eventType !== 'resolve') throw new TypeError('artifact passport history must end at a resolution');
  for (let index = 1; index < history.length; index += 1) {
    const current = history[index];
    const expected = index % 2 === 1 ? 'review' : 'resolve';
    if (current.eventType !== expected) throw new TypeError('artifact passport history lifecycle is invalid');
    if (current.eventType === 'review' && (!nonEmpty(current.payload.reason, 'review reason') || !current.payload.source || current.payload.source.kind !== 'review_evidence' || current.payload.source.revision !== artifact.revision.value)) throw new TypeError('artifact passport review event is invalid');
    if (current.eventType === 'resolve' && (!DECISIONS.has(current.payload.decision) || !nonEmpty(current.payload.reason, 'resolve reason') || !current.payload.source || current.payload.source.reviewEventId !== history[index - 1].eventId || current.payload.source.revision !== artifact.revision.value)) throw new TypeError('artifact passport resolve event is invalid');
  }
  const final = history[history.length - 1];
  if (final.eventType === 'resolve') {
    if (artifact.task.status !== final.payload.decision || artifact.review.decision !== final.payload.decision || artifact.review.status !== 'completed' || artifact.review.reviewerAgentId !== final.actorAgentId) throw new TypeError('review state is inconsistent with passport resolution');
  } else if (artifact.task.status !== 'awaiting_review' || artifact.review.status !== 'pending' || artifact.review.decision !== null) throw new TypeError('pending review state is inconsistent');
  validateResultStore(artifact);
  if (!artifact.passport.current || !Array.isArray(artifact.passport.timeline) || !isDeepStrictEqual(artifact.passport.current, rebuildCurrent(history)) || !isDeepStrictEqual(artifact.passport.timeline, makeTimeline(history))) throw new TypeError('passport current/timeline do not match history');
}

function rebuildCurrent(history) {
  const created = history[0];
  const state = { memoryId: created.memoryId, status: 'active', content: structuredClone(created.payload.content), createdByAgentId: created.actorAgentId, lastEventId: created.eventId, seq: created.seq };
  if (Object.hasOwn(created.payload, 'source')) state.source = structuredClone(created.payload.source);
  for (const event of history.slice(1)) {
    if (event.eventType === 'review') { state.status = 'disputed'; state.reviewReason = event.payload.reason; delete state.disputeReason; delete state.resolution; }
    else if (event.eventType === 'resolve') { state.status = 'resolved'; state.resolution = { adjudicatorAgentId: event.actorAgentId, reason: event.payload.reason, decision: event.payload.decision }; delete state.disputeReason; delete state.reviewReason; if (Object.hasOwn(event.payload, 'content')) { state.content = structuredClone(event.payload.content); if (!Object.hasOwn(event.payload, 'source')) delete state.source; } if (Object.hasOwn(event.payload, 'source')) state.source = structuredClone(event.payload.source); }
    state.lastEventId = event.eventId; state.seq = event.seq;
  }
  return state;
}

function makeTimeline(history) {
  let status = 'active';
  return history.map((event) => {
    const entry = {
      seq: event.seq, eventId: event.eventId, timestamp: event.timestamp, actorAgentId: event.actorAgentId, eventType: event.eventType
    };
    if (event.eventType === 'create') {
      entry.summary = 'Created memory';
      entry.contentChanged = true;
    } else if (event.eventType === 'review') {
      entry.summary = status === 'resolved' ? 'Requested review again' : 'Requested review';
      entry.reason = event.payload.reason;
      status = 'disputed';
    } else if (event.eventType === 'resolve') {
      entry.summary = `Resolved dispute: ${event.payload.decision}`;
      entry.reason = event.payload.reason;
      entry.decision = event.payload.decision;
      entry.contentChanged = Object.hasOwn(event.payload, 'content');
      status = 'resolved';
    }
    entry.sourceProvided = Object.hasOwn(event.payload, 'source');
    entry.statusAfter = status;
    return entry;
  });
}

async function captureAgentTask({ cwd, taskId, prompt, agentId = 'agent', run, handoffKind = 'agent_handoff', reviewAgentId = 'reviewer', test = true, artifactPath, allowedPaths } = {}) {
  nonEmpty(cwd, 'cwd'); nonEmpty(taskId, 'taskId'); nonEmpty(prompt, 'prompt'); nonEmpty(agentId, 'agentId'); nonEmpty(reviewAgentId, 'reviewAgentId');
  if (typeof run !== 'function') throw new TypeError('run must be a function');
  if (reviewAgentId === agentId) throw new TypeError('reviewAgentId must be independent from agent');
  const root = path.resolve(cwd);
  const scope = normalizeAllowedPaths(root, allowedPaths);
  const baseRevision = await revisionFingerprint(root, artifactPath);
  const before = await git(root, ['status', '--short']);
  const changedBefore = await changedPaths(root, artifactPath);
  const execution = await run({ cwd: root, taskId, prompt });
  if (!execution || typeof execution !== 'object' || typeof execution.code !== 'number') throw new TypeError('agent adapter returned an invalid execution result');
  const agent = execution;
  const after = await git(root, ['status', '--short']);
  const changedAfter = await changedPaths(root, artifactPath);
  const diffCheck = await git(root, ['diff', '--check']);
  const tests = test ? await runProcess('npm', ['test'], root) : { code: 0, stdout: '', stderr: '', skipped: true };
  const revision = await revisionFingerprint(root, artifactPath);
  const scopeViolations = scope === null ? [] : changedAfter.filter((changed) => !pathAllowed(changed, scope));
  const taskStatus = agent.code !== 0 ? 'execution_failed' : diffCheck.code !== 0 ? 'diff_check_failed' : tests.code !== 0 ? 'tests_failed' : scopeViolations.length > 0 ? 'scope_violation' : 'awaiting_review';
  const store = new ResultStore();
  const handoff = relayExternalResult({ agentId, result: { taskId, exitCode: agent.code, signal: agent.signal, stdout: agent.stdout, stderr: agent.stderr } });
  nonEmpty(handoffKind, 'handoffKind');
  const handoffEvent = store.append(agentId, { kind: handoffKind, result: handoff, statusBefore: before.stdout, statusAfter: after.stdout });
  const verification = store.append('agent-task-runner', { kind: 'runner_verification', checks: { agentExit: agent.code === 0, gitDiffCheck: diffCheck.code === 0, tests: tests.skipped ? 'skipped' : tests.code === 0 }, testOutput: tests.stdout, diffCheckOutput: diffCheck.stderr || diffCheck.stdout, statusAfter: after.stdout });
  store.append('agent-task-runner', { kind: 'review_request', requestedReviewerAgentId: reviewAgentId, reviewedRevision: revision.value });
  const passport = new MemoryPassport();
  const memoryId = `agent-task-${taskId}`;
  passport.create({ memoryId, actorAgentId: agentId, content: { taskId, status: agent.code === 0 ? 'ready_for_review' : 'execution_failed' }, source: { resultSequence: handoffEvent.sequence, kind: handoffKind } });
  return {
    version: VERSION, schema: SCHEMA, taskId, cwd: root, baseRevision, revision, resultStore: store.readAll(),
    passport: { memoryId, history: passport.history(memoryId), current: passport.current(memoryId), timeline: passport.timeline(memoryId) },
    process: { agent, tests, diffCheck },
    scope: { allowedPaths: scope, changedBefore, changedAfter, violations: scopeViolations },
    review: { required: taskStatus === 'awaiting_review', status: taskStatus === 'awaiting_review' ? 'pending' : 'blocked', decision: null, requestedReviewerAgentId: reviewAgentId, runnerVerificationSequence: verification.sequence },
    task: { status: taskStatus }, reviewRequired: taskStatus === 'awaiting_review'
  };
}

async function resolveCapturedTask({ artifactPath, decision, adjudicatorAgentId = 'reviewer', reason, content, acceptedSchemas = [SCHEMA] } = {}) {
  nonEmpty(artifactPath, 'artifactPath'); nonEmpty(decision, 'decision'); nonEmpty(adjudicatorAgentId, 'adjudicatorAgentId'); nonEmpty(reason, 'reason');
  if (!DECISIONS.has(decision)) throw new TypeError(`decision must be one of: ${[...DECISIONS].join(', ')}`);
  const artifact = JSON.parse(await fsp.readFile(path.resolve(artifactPath), 'utf8'));
  if (!Array.isArray(acceptedSchemas) || acceptedSchemas.some((schema) => typeof schema !== 'string')) throw new TypeError('acceptedSchemas must be an array of strings');
  validateArtifact(artifact, acceptedSchemas);
  if (!['awaiting_review', 'changes_requested', 'inconclusive'].includes(artifact.task.status)) {
    throw new Error(`task is not reviewable: ${artifact.task.status}`);
  }
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

module.exports = { VERSION, SCHEMA, captureAgentTask, resolveCapturedTask, runProcess };
