'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { captureCodexTask, resolveCapturedTask } = require('./bin/guard-codex-task');

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

test('run records runner verification and a request without a fake reviewer event', { concurrency: false }, async () => {
  const { artifact } = await fixture();
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
