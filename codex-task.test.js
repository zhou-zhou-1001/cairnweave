'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { resolveCapturedTask } = require('./bin/guard-codex-task');

test('resolveCapturedTask replays review history before accepting a task', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'guard-codex-task-'));
  const artifactPath = path.join(directory, 'task.guard.json');
  await fs.writeFile(artifactPath, JSON.stringify({
    version: 1,
    taskId: 'fixture-task',
    passport: {
      memoryId: 'codex-task-fixture-task',
      history: [
        {
          eventType: 'create',
          actorAgentId: 'codex',
          payload: {
            content: { taskId: 'fixture-task', status: 'ready_for_review' },
            source: { resultSequence: 1 }
          }
        },
        {
          eventType: 'review',
          actorAgentId: 'reviewer',
          payload: {
            reason: 'Independent checks passed',
            source: { resultSequence: 2 }
          }
        }
      ]
    },
    reviewRequired: true
  }));

  const resolved = await resolveCapturedTask({
    artifactPath,
    decision: 'accept',
    adjudicatorAgentId: 'reviewer',
    reason: 'Verified the captured evidence'
  });

  assert.equal(resolved.reviewRequired, false);
  assert.equal(resolved.passport.current.status, 'resolved');
  assert.equal(resolved.passport.current.resolution.decision, 'accept');
  assert.deepEqual(resolved.passport.history.map((event) => event.eventType), ['create', 'review', 'resolve']);
});

test('resolveCapturedTask rejects an artifact without an open review', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'guard-codex-task-'));
  const artifactPath = path.join(directory, 'task.guard.json');
  await fs.writeFile(artifactPath, JSON.stringify({
    taskId: 'unreviewed-task',
    passport: {
      memoryId: 'codex-task-unreviewed-task',
      history: [{
        eventType: 'create',
        actorAgentId: 'codex',
        payload: { content: { ok: true }, source: { resultSequence: 1 } }
      }]
    }
  }));

  await assert.rejects(
    resolveCapturedTask({ artifactPath, decision: 'accept', reason: 'No review exists' }),
    /only a disputed memory can be resolved/
  );
});
