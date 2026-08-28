'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { captureAgentTask, captureCodexTask, resolveCapturedTask } = require('./bin/guard-codex-task');
const { captureCommandTask, parseRunArguments, writeArtifact } = require('./bin/guard-agent-task');
const { loadArtifact, saveArtifact } = require('./artifact-store');

function command(cwd, executable, args) {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8', shell: false });
  assert.equal(result.status, 0, result.stderr);
}

async function fixture(reviewAgentId = 'reviewer') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'guard-codex-task-'));
  const repository = path.join(directory, 'repository');
  const fakeBin = path.join(directory, 'bin');
  await fs.mkdir(repository);
  await fs.mkdir(fakeBin);
  command(repository, 'git', ['init', '-q']);
  command(repository, 'git', ['config', 'user.email', 'test@example.invalid']);
  command(repository, 'git', ['config', 'user.name', 'Test']);
  await fs.writeFile(path.join(repository, 'tracked.txt'), 'baseline\n');
  command(repository, 'git', ['add', 'tracked.txt']);
  command(repository, 'git', ['commit', '-qm', 'baseline']);
  const codexPath = path.join(fakeBin, 'codex');
  await fs.writeFile(codexPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const artifactPath = path.join(repository, 'task.guard.json');
  const originalPath = process.env.PATH;
  process.env.PATH = `${fakeBin}${path.delimiter}${originalPath}`;
  let artifact;
  try {
    artifact = await captureCodexTask({ cwd: repository, taskId: 'fixture-task', prompt: 'do nothing', test: false, artifactPath, reviewAgentId });
  } finally {
    process.env.PATH = originalPath;
  }
  await fs.writeFile(artifactPath, JSON.stringify(artifact));
  return { repository, artifactPath, artifact };
}

async function changingFixture(allowedPaths, commandText) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'guard-codex-scope-'));
  const repository = path.join(directory, 'repository');
  const fakeBin = path.join(directory, 'bin');
  await fs.mkdir(repository);
  await fs.mkdir(fakeBin);
  command(repository, 'git', ['init', '-q']);
  command(repository, 'git', ['config', 'user.email', 'test@example.invalid']);
  command(repository, 'git', ['config', 'user.name', 'Test']);
  await fs.writeFile(path.join(repository, 'allowed.txt'), 'baseline\n');
  command(repository, 'git', ['add', 'allowed.txt']);
  command(repository, 'git', ['commit', '-qm', 'baseline']);
  const codexPath = path.join(fakeBin, 'codex');
  await fs.writeFile(codexPath, `#!/bin/sh\n${commandText}\n`, { mode: 0o755 });
  const originalPath = process.env.PATH;
  process.env.PATH = `${fakeBin}${path.delimiter}${originalPath}`;
  try {
    return await captureCodexTask({ cwd: repository, taskId: 'scope-task', prompt: 'change files', test: false, allowedPaths });
  } finally {
    process.env.PATH = originalPath;
  }
}

test('run records runner verification and a request without a fake reviewer event', { concurrency: false }, async () => {
  const { artifact } = await fixture();
  assert.equal(artifact.schema, 'agent-integrity-guard/codex-task');
  assert.match(artifact.passport.memoryId, /^codex-task-/);
  assert.equal(Object.hasOwn(artifact.process, 'codex'), true);
  assert.deepEqual(artifact.passport.history.map((event) => event.eventType), ['create']);
  assert.equal(artifact.passport.history.some((event) => event.actorAgentId === 'reviewer'), false);
  assert.deepEqual(artifact.resultStore.map((event) => [event.agentId, event.event.kind]), [
    ['codex', 'codex_handoff'],
    ['codex-task-runner', 'runner_verification'],
    ['codex-task-runner', 'review_request']
  ]);
  assert.equal(artifact.review.status, 'pending');
});

test('resolve rejects decisions outside the closed enum', { concurrency: false }, async () => {
  const { artifactPath } = await fixture();
  await assert.rejects(resolveCapturedTask({ artifactPath, decision: 'accept', reason: 'checked' }), /decision must be one of/);
});

test('resolve rejects a repository revision mismatch', { concurrency: false }, async () => {
  const { repository, artifactPath } = await fixture();
  await fs.writeFile(path.join(repository, 'untracked.txt'), 'new review input\n');
  await assert.rejects(resolveCapturedTask({ artifactPath, decision: 'accepted', reason: 'checked' }), /revision mismatch/);
});

test('accepted and rejected outcomes are distinct and preserve captured history identity', { concurrency: false }, async () => {
  for (const decision of ['accepted', 'rejected']) {
    const { artifactPath, artifact } = await fixture();
    const original = structuredClone(artifact.passport.history[0]);
    const resolved = await resolveCapturedTask({ artifactPath, decision, reason: `${decision} after review` });
    assert.deepEqual(resolved.passport.history[0], original);
    assert.deepEqual(resolved.passport.history.map((event) => event.eventType), ['create', 'review', 'resolve']);
    assert.equal(resolved.passport.history[1].actorAgentId, 'reviewer');
    assert.equal(resolved.review.decision, decision);
    assert.equal(resolved.review.required, false);
    assert.equal(resolved.task.status, decision);
    assert.equal(resolved.reviewRequired, false);
  }
});

test('changes requested remains review-required and supports a second review cycle', { concurrency: false }, async () => {
  const { artifactPath } = await fixture();
  const first = await resolveCapturedTask({ artifactPath, decision: 'changes_requested', reason: 'one issue remains' });
  await fs.writeFile(artifactPath, JSON.stringify(first));
  const second = await resolveCapturedTask({ artifactPath, decision: 'accepted', reason: 'issue fixed' });
  assert.equal(first.review.status, 'completed');
  assert.equal(first.review.required, true);
  assert.equal(first.task.status, 'changes_requested');
  assert.equal(first.reviewRequired, true);
  assert.deepEqual(second.passport.history.map((event) => event.eventType), ['create', 'review', 'resolve', 'review', 'resolve']);
  assert.deepEqual(second.passport.history.map((event) => event.seq), [1, 2, 3, 4, 5]);
  assert.equal(second.review.required, false);
  assert.equal(second.task.status, 'accepted');
});

test('runner and reviewer identities cannot be the task agent', { concurrency: false }, async () => {
  await assert.rejects(fixture('codex'), /reviewAgentId must be independent/);
  const { artifactPath, artifact } = await fixture();
  await assert.rejects(resolveCapturedTask({ artifactPath, decision: 'accepted', adjudicatorAgentId: artifact.passport.history[0].actorAgentId, reason: 'checked' }), /adjudicatorAgentId must be independent/);
});

test('scope violations block review and record changed paths', { concurrency: false }, async () => {
  const artifact = await changingFixture(['allowed.txt'], 'printf changed > forbidden.txt');
  assert.equal(artifact.task.status, 'scope_violation');
  assert.equal(artifact.review.required, false);
  assert.deepEqual(artifact.scope.allowedPaths, ['allowed.txt']);
  assert.deepEqual(artifact.scope.violations, ['forbidden.txt']);
  await assert.rejects(
    resolveCapturedTask({ artifactPath: path.join(os.tmpdir(), 'missing-artifact.json'), decision: 'accepted', reason: 'checked' }),
    /ENOENT/
  );
});

test('failed Codex execution is not reviewable', { concurrency: false }, async () => {
  const artifact = await changingFixture(undefined, 'exit 7');
  assert.equal(artifact.task.status, 'execution_failed');
  assert.equal(artifact.review.required, false);
});

test('generic agent adapters use the same guard lifecycle', { concurrency: false }, async () => {
  const { repository } = await fixture();
  const artifact = await captureAgentTask({
    cwd: repository,
    taskId: 'generic-task',
    prompt: 'do nothing',
    agentId: 'claude-code',
    test: false,
    run: async () => ({ code: 0, signal: null, stdout: 'ok', stderr: '' })
  });
  assert.equal(artifact.task.status, 'awaiting_review');
  assert.equal(artifact.resultStore[0].agentId, 'claude-code');
  assert.equal(artifact.resultStore[0].event.kind, 'agent_handoff');
  assert.equal(artifact.passport.history[0].actorAgentId, 'claude-code');
  assert.equal(artifact.schema, 'agent-integrity-guard/agent-task');
  assert.match(artifact.passport.memoryId, /^agent-task-/);
  assert.deepEqual(artifact.resultStore.slice(1).map((event) => event.agentId), ['agent-task-runner', 'agent-task-runner']);
  assert.equal(artifact.process.agent.stdout, 'ok');
  assert.equal(Object.hasOwn(artifact.process, 'codex'), false);
});

test('generic command adapter executes without Codex-specific artifact fields', { concurrency: false }, async () => {
  const { repository } = await fixture();
  const artifact = await captureCommandTask({
    cwd: repository, taskId: 'command-task', prompt: 'stdin payload', command: process.execPath,
    args: ['-e', 'process.stdin.pipe(process.stdout)'], agentId: 'local-command', test: false
  });
  assert.equal(artifact.task.status, 'awaiting_review');
  assert.equal(artifact.process.agent.stdout, 'stdin payload');
  assert.equal(artifact.resultStore[0].agentId, 'local-command');
  assert.equal(artifact.resultStore[1].event.checks.agentExit, true);
});

test('generic CLI parsing keeps command flags separate from runner options', () => {
  assert.deepEqual(parseRunArguments([
    '.', 'task', 'prompt', '--output=nested/task.json', '--allow=docs', '--', 'agent-cli', '--output=agent.json', '--flag'
  ]), {
    cwd: '.', taskId: 'task', prompt: 'prompt', command: 'agent-cli',
    args: ['--output=agent.json', '--flag'], output: 'nested/task.json', allowedPaths: ['docs']
  });
  assert.throws(() => parseRunArguments(['.', 'task', 'prompt', 'agent-cli', '--output=task.json']), /must precede a --/);
  assert.throws(() => parseRunArguments(['.', 'task', 'prompt', '--unknown', '--', 'agent-cli']), /unknown run option/);
});

test('generic CLI artifact writing creates parent directories', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'guard-agent-write-'));
  const destination = path.join(directory, 'nested', 'task.guard.json');
  await writeArtifact(destination, { schema: 'test', value: 1 });
  assert.deepEqual(JSON.parse(await fs.readFile(destination, 'utf8')), { schema: 'test', value: 1 });
});

test('generic artifacts preserve the existing review lifecycle', { concurrency: false }, async () => {
  const { repository } = await fixture();
  const artifactPath = path.join(repository, 'generic.guard.json');
  const artifact = await captureAgentTask({
    cwd: repository, taskId: 'generic-review', prompt: 'do nothing', agentId: 'generic-agent',
    artifactPath, test: false, run: async () => ({ code: 0, signal: null, stdout: '', stderr: '' })
  });
  await fs.writeFile(artifactPath, JSON.stringify(artifact));
  const resolved = await require('./core/agent-task').resolveCapturedTask({ artifactPath, decision: 'accepted', reason: 'checked' });
  assert.deepEqual(resolved.passport.history.map((event) => event.eventType), ['create', 'review', 'resolve']);
  assert.equal(resolved.review.required, false);
  assert.equal(resolved.task.status, 'accepted');
});

test('generic artifacts can continue after a non-final resolution', { concurrency: false }, async () => {
  const { repository } = await fixture();
  const artifactPath = path.join(repository, 'generic-cycle.guard.json');
  const artifact = await captureAgentTask({
    cwd: repository, taskId: 'generic-cycle', prompt: 'do nothing', agentId: 'generic-agent',
    artifactPath, test: false, run: async () => ({ code: 0, signal: null, stdout: '', stderr: '' })
  });
  await fs.writeFile(artifactPath, JSON.stringify(artifact));
  const resolveGeneric = require('./core/agent-task').resolveCapturedTask;
  const first = await resolveGeneric({ artifactPath, decision: 'changes_requested', reason: 'fix one issue' });
  await fs.writeFile(artifactPath, JSON.stringify(first));
  const second = await resolveGeneric({ artifactPath, decision: 'accepted', reason: 'issue fixed' });
  assert.deepEqual(second.passport.history.map((event) => event.eventType), ['create', 'review', 'resolve', 'review', 'resolve']);
  assert.equal(second.review.required, false);
});

test('artifact persistence detects tampering and survives round trip', { concurrency: false }, async () => {
  const { artifact } = await fixture();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'guard-artifact-'));
  const artifactPath = path.join(directory, 'artifact.json');
  await saveArtifact(artifactPath, artifact);
  assert.deepEqual(await loadArtifact(artifactPath), artifact);
  const envelope = JSON.parse(await fs.readFile(artifactPath, 'utf8'));
  envelope.artifact.task.status = 'accepted';
  await fs.writeFile(artifactPath, JSON.stringify(envelope));
  await assert.rejects(loadArtifact(artifactPath), /integrity mismatch/);
});

async function tamperedResolve(artifactPath, artifact, mutate) {
  const clone = structuredClone(artifact);
  mutate(clone);
  await fs.writeFile(artifactPath, JSON.stringify(clone));
  return resolveCapturedTask({ artifactPath, decision: 'accepted', reason: 'checked' });
}

test('resolve rejects tampered resultStore chains', { concurrency: false }, async () => {
  const { artifactPath, artifact } = await fixture();
  await assert.rejects(tamperedResolve(artifactPath, artifact, (a) => { a.resultStore[0].agentId = 'forged-agent'; }), /resultStore handoff is inconsistent/);
  await assert.rejects(tamperedResolve(artifactPath, artifact, (a) => { a.resultStore[0].event.result.result.taskId = 'forged'; }), /resultStore handoff is inconsistent/);
  await assert.rejects(tamperedResolve(artifactPath, artifact, (a) => { a.resultStore[1].event.kind = 'runner_verification_forged'; }), /resultStore runner verification is inconsistent/);
  await assert.rejects(tamperedResolve(artifactPath, artifact, (a) => { a.resultStore[2].event.requestedReviewerAgentId = 'attacker'; }), /resultStore review request is inconsistent/);
  await assert.rejects(tamperedResolve(artifactPath, artifact, (a) => { a.resultStore[2].event.reviewedRevision = 'f'.repeat(64); }), /resultStore review request is inconsistent/);
  await assert.rejects(tamperedResolve(artifactPath, artifact, (a) => { a.resultStore[2].sequence = 4; }), /resultStore review request is inconsistent/);
  await assert.rejects(tamperedResolve(artifactPath, artifact, (a) => { a.resultStore.pop(); }), /resultStore is invalid/);
});

test('resolve rejects tampered passport current state', { concurrency: false }, async () => {
  const { artifactPath, artifact } = await fixture();
  await assert.rejects(tamperedResolve(artifactPath, artifact, (a) => { a.passport.current.content.taskId = 'forged'; }), /passport current\/timeline do not match history/);
  await assert.rejects(tamperedResolve(artifactPath, artifact, (a) => { a.passport.current.lastEventId = 'forged'; }), /passport current\/timeline do not match history/);
  await assert.rejects(tamperedResolve(artifactPath, artifact, (a) => { a.passport.current.status = 'resolved'; }), /passport current\/timeline do not match history/);
  await assert.rejects(tamperedResolve(artifactPath, artifact, (a) => { delete a.passport.current.source; }), /passport current\/timeline do not match history/);
});

test('resolve rejects tampered passport timeline', { concurrency: false }, async () => {
  const { artifactPath, artifact } = await fixture();
  await assert.rejects(tamperedResolve(artifactPath, artifact, (a) => { a.passport.timeline[0].summary = 'Forged summary'; }), /passport current\/timeline do not match history/);
  await assert.rejects(tamperedResolve(artifactPath, artifact, (a) => { a.passport.timeline[0].statusAfter = 'resolved'; }), /passport current\/timeline do not match history/);
  await assert.rejects(tamperedResolve(artifactPath, artifact, (a) => { a.passport.timeline.pop(); }), /passport current\/timeline do not match history/);
});

test('resolve rejects a forged taskId and non-normalized cwd', { concurrency: false }, async () => {
  const { artifactPath, artifact } = await fixture();
  await assert.rejects(tamperedResolve(artifactPath, artifact, (a) => { a.taskId = 'forged-task'; }), /passport create event is invalid/);
  await assert.rejects(tamperedResolve(artifactPath, artifact, (a) => { a.cwd = `${a.cwd}/sub`; }), /cwd must be an existing directory/);
  await assert.rejects(tamperedResolve(artifactPath, artifact, (a) => { a.cwd = a.cwd.replace(/^\//, ''); }), /cwd must be absolute and normalized/);
});

test('resolve rejects a forged runnerVerificationSequence', { concurrency: false }, async () => {
  const { artifactPath, artifact } = await fixture();
  await assert.rejects(tamperedResolve(artifactPath, artifact, (a) => { a.review.runnerVerificationSequence = 99; }), /runnerVerificationSequence is inconsistent/);
  await assert.rejects(tamperedResolve(artifactPath, artifact, (a) => { delete a.review.runnerVerificationSequence; }), /runnerVerificationSequence is inconsistent/);
});

test('resolve rejects duplicate passport event ids', { concurrency: false }, async () => {
  const { artifactPath, artifact } = await fixture();
  const first = await resolveCapturedTask({ artifactPath, decision: 'changes_requested', reason: 'one issue remains' });
  await fs.writeFile(artifactPath, JSON.stringify(first));
  const tampered = structuredClone(first);
  tampered.passport.history[1].eventId = tampered.passport.history[0].eventId;
  await fs.writeFile(artifactPath, JSON.stringify(tampered));
  await assert.rejects(resolveCapturedTask({ artifactPath, decision: 'accepted', reason: 'issue fixed' }), /passport history sequence is invalid/);
});

test('resolve rejects tampered revision components', { concurrency: false }, async () => {
  const { artifactPath, artifact } = await fixture();
  await assert.rejects(tamperedResolve(artifactPath, artifact, (a) => { a.revision.components.worktree = 'a'.repeat(64); }), /revision components do not match value/i);
  await assert.rejects(tamperedResolve(artifactPath, artifact, (a) => { a.baseRevision.components.index = 'b'.repeat(40); }), /revision components do not match value/i);
  await assert.rejects(tamperedResolve(artifactPath, artifact, (a) => { a.revision.value = 'c'.repeat(64); }), /revision components do not match value/i);
});

test('resolve rejects review state inconsistent with task status', { concurrency: false }, async () => {
  const { artifactPath, artifact } = await fixture();
  await assert.rejects(tamperedResolve(artifactPath, artifact, (a) => { a.task.status = 'accepted'; }), /artifact.review is inconsistent with task status/);
  await assert.rejects(tamperedResolve(artifactPath, artifact, (a) => { a.reviewRequired = false; }), /reviewRequired is inconsistent/);
  await assert.rejects(tamperedResolve(artifactPath, artifact, (a) => { a.review.decision = 'accepted'; }), /artifact.review is inconsistent with task status/);
  await assert.rejects(tamperedResolve(artifactPath, artifact, (a) => { a.review.status = 'completed'; }), /artifact.review is inconsistent with task status/);
  await assert.rejects(tamperedResolve(artifactPath, artifact, (a) => { a.review.requestedReviewerAgentId = 'attacker'; }), /resultStore review request is inconsistent/);
});

test('resolve rejects missing or forged passport payload fields', { concurrency: false }, async () => {
  const { artifactPath, artifact } = await fixture();
  await assert.rejects(tamperedResolve(artifactPath, artifact, (a) => { delete a.passport.history[0].payload.source; }), /passport create event is invalid/);
  await assert.rejects(tamperedResolve(artifactPath, artifact, (a) => { a.passport.history[0].eventType = 'update'; }), /passport create event is invalid/);
});

test('resolve rejects an accepted artifact whose history ends before a resolution', { concurrency: false }, async () => {
  const { artifactPath, artifact } = await fixture();
  const resolved = await resolveCapturedTask({ artifactPath, decision: 'changes_requested', reason: 'one issue remains' });
  await fs.writeFile(artifactPath, JSON.stringify(resolved));
  const tampered = structuredClone(resolved);
  tampered.passport.history.pop();
  await fs.writeFile(artifactPath, JSON.stringify(tampered));
  await assert.rejects(resolveCapturedTask({ artifactPath, decision: 'accepted', reason: 'issue fixed' }), /passport history must end at a resolution/);
});
