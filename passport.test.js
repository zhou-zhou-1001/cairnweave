'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MemoryPassport } = require('./memory-passport');

function createPassport() {
  const passport = new MemoryPassport();
  passport.create({ memoryId: 'memory-1', actorAgentId: 'observer', content: { claim: 'v1' } });
  return passport;
}

test('create records a complete first event and active current state', () => {
  const passport = createPassport();
  const event = passport.history('memory-1')[0];
  assert.match(event.eventId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(
    { memoryId: event.memoryId, seq: event.seq, eventType: event.eventType, actor: event.actorAgentId },
    { memoryId: 'memory-1', seq: 1, eventType: 'create', actor: 'observer' }
  );
  assert.equal(passport.current('memory-1').status, 'active');
});

test('create, update, dispute, resolve remain in append order', () => {
  const passport = createPassport();
  passport.update('memory-1', { actorAgentId: 'editor', content: { claim: 'v2' } });
  passport.dispute('memory-1', { actorAgentId: 'reviewer', reason: 'conflicting evidence' });
  passport.resolve('memory-1', {
    adjudicatorAgentId: 'judge', reason: 'primary record checked', decision: 'accept update'
  });
  const events = passport.history('memory-1');
  assert.deepEqual(events.map((event) => event.eventType), ['create', 'update', 'dispute', 'resolve']);
  assert.deepEqual(events.map((event) => event.seq), [1, 2, 3, 4]);
  assert.ok(events.every((event) => !Number.isNaN(Date.parse(event.timestamp))));
});

test('duplicate memory ids are rejected instead of overwriting history', () => {
  const passport = createPassport();
  assert.throws(
    () => passport.create({ memoryId: 'memory-1', actorAgentId: 'other', content: 'replacement' }),
    /already exists/
  );
  assert.equal(passport.history('memory-1').length, 1);
});

test('ordinary updates do not erase a disputed state', () => {
  const passport = createPassport();
  passport.dispute('memory-1', { actorAgentId: 'reviewer', reason: 'needs corroboration' });
  passport.update('memory-1', { actorAgentId: 'editor', content: { claim: 'v2' } });
  assert.equal(passport.current('memory-1').status, 'disputed');
  assert.equal(passport.current('memory-1').disputeReason, 'needs corroboration');
});

test('an open dispute cannot be silently replaced by a second dispute', () => {
  const passport = createPassport();
  passport.dispute('memory-1', { actorAgentId: 'reviewer-a', reason: 'first conflict' });
  assert.throws(
    () => passport.dispute('memory-1', { actorAgentId: 'reviewer-b', reason: 'different conflict' }),
    /already has an open dispute/
  );
  assert.equal(passport.history('memory-1').length, 2);
  assert.equal(passport.current('memory-1').disputeReason, 'first conflict');
});

test('resolve requires an adjudicator, reason, decision, and an open dispute', () => {
  const passport = createPassport();
  assert.throws(() => passport.resolve('memory-1', { reason: 'checked', decision: 'accept' }), /adjudicator/);
  assert.throws(() => passport.resolve('memory-1', {
    adjudicatorAgentId: 'judge', reason: 'checked', decision: 'accept'
  }), /only a disputed memory/);
  passport.dispute('memory-1', { actorAgentId: 'reviewer', reason: 'conflict' });
  assert.throws(() => passport.resolve('memory-1', {
    adjudicatorAgentId: 'judge', decision: 'accept'
  }), /reason/);
});

test('resolution records the explicit adjudication in current state', () => {
  const passport = createPassport();
  passport.dispute('memory-1', { actorAgentId: 'reviewer', reason: 'conflict' });
  passport.resolve('memory-1', {
    adjudicatorAgentId: 'judge', reason: 'source A is authoritative', decision: 'replace',
    content: { claim: 'adjudicated' }
  });
  assert.deepEqual(passport.current('memory-1').resolution, {
    adjudicatorAgentId: 'judge', reason: 'source A is authoritative', decision: 'replace'
  });
  assert.deepEqual(passport.current('memory-1').content, { claim: 'adjudicated' });
});

test('resolved content cannot change without opening a new dispute', () => {
  const passport = createPassport();
  passport.dispute('memory-1', { actorAgentId: 'reviewer', reason: 'conflict' });
  passport.resolve('memory-1', {
    adjudicatorAgentId: 'judge', reason: 'record checked', decision: 'retain'
  });

  assert.throws(
    () => passport.update('memory-1', { actorAgentId: 'editor', content: { claim: 'v2' } }),
    /must be disputed before it can be updated/
  );
  assert.equal(passport.history('memory-1').length, 3);
});

test('a resolved memory can be explicitly reopened and adjudicated again', () => {
  const passport = createPassport();
  passport.dispute('memory-1', { actorAgentId: 'reviewer', reason: 'first conflict' });
  passport.resolve('memory-1', {
    adjudicatorAgentId: 'judge-a', reason: 'first record checked', decision: 'retain'
  });
  passport.dispute('memory-1', { actorAgentId: 'reviewer-b', reason: 'new evidence' });

  const reopened = passport.current('memory-1');
  assert.equal(reopened.status, 'disputed');
  assert.equal(reopened.disputeReason, 'new evidence');
  assert.equal(Object.hasOwn(reopened, 'resolution'), false);

  passport.update('memory-1', { actorAgentId: 'editor', content: { claim: 'v2' } });
  passport.resolve('memory-1', {
    adjudicatorAgentId: 'judge-b', reason: 'new evidence checked', decision: 'replace'
  });
  assert.deepEqual(passport.history('memory-1').map((event) => event.eventType), [
    'create', 'dispute', 'resolve', 'dispute', 'update', 'resolve'
  ]);
  assert.equal(passport.current('memory-1').status, 'resolved');
  assert.equal(passport.current('memory-1').resolution.adjudicatorAgentId, 'judge-b');
});

test('inputs and returned history/current values are defensive copies', () => {
  const passport = new MemoryPassport();
  const content = { nested: { value: 'original' } };
  passport.create({ memoryId: 'memory-1', actorAgentId: 'observer', content });
  content.nested.value = 'input mutation';
  const history = passport.history('memory-1');
  const current = passport.current('memory-1');
  history[0].payload.content.nested.value = 'history mutation';
  current.content.nested.value = 'current mutation';
  assert.equal(passport.current('memory-1').content.nested.value, 'original');
});

test('source is retained only when explicitly supplied', () => {
  const passport = new MemoryPassport();
  passport.create({ memoryId: 'with-source', actorAgentId: 'observer', content: 'claim', source: { url: 'explicit' } });
  passport.create({ memoryId: 'without-source', actorAgentId: 'observer', content: 'claim' });
  assert.deepEqual(passport.current('with-source').source, { url: 'explicit' });
  assert.equal(Object.hasOwn(passport.current('without-source'), 'source'), false);
  assert.equal(Object.hasOwn(passport.history('without-source')[0].payload, 'source'), false);
});

test('an update without a source does not inherit or fabricate one', () => {
  const passport = new MemoryPassport();
  passport.create({ memoryId: 'memory-1', actorAgentId: 'observer', content: 'v1', source: 'record-a' });
  passport.update('memory-1', { actorAgentId: 'editor', content: 'v2' });
  assert.equal(Object.hasOwn(passport.current('memory-1'), 'source'), false);
  assert.equal(Object.hasOwn(passport.history('memory-1')[1].payload, 'source'), false);
});

test('replacement content from a resolution does not inherit an old source', () => {
  const passport = new MemoryPassport();
  passport.create({ memoryId: 'memory-1', actorAgentId: 'observer', content: 'v1', source: 'record-a' });
  passport.dispute('memory-1', { actorAgentId: 'reviewer', reason: 'conflict' });
  passport.resolve('memory-1', {
    adjudicatorAgentId: 'judge', reason: 'reconstructed independently', decision: 'replace', content: 'v2'
  });
  assert.equal(Object.hasOwn(passport.current('memory-1'), 'source'), false);
});

test('timeline explains lifecycle transitions without copying arbitrary content', () => {
  const passport = new MemoryPassport();
  passport.create({
    memoryId: 'memory-1', actorAgentId: 'observer', content: { secret: 'not a summary' }, source: 'record-a'
  });
  passport.dispute('memory-1', { actorAgentId: 'reviewer', reason: 'conflicting evidence' });
  passport.resolve('memory-1', {
    adjudicatorAgentId: 'judge', reason: 'primary record checked', decision: 'retain'
  });
  passport.dispute('memory-1', { actorAgentId: 'reviewer-b', reason: 'new evidence' });

  const timeline = passport.timeline('memory-1');
  assert.deepEqual(timeline.map(({ summary, statusAfter }) => ({ summary, statusAfter })), [
    { summary: 'Created memory', statusAfter: 'active' },
    { summary: 'Opened dispute', statusAfter: 'disputed' },
    { summary: 'Resolved dispute: retain', statusAfter: 'resolved' },
    { summary: 'Reopened dispute', statusAfter: 'disputed' }
  ]);
  assert.equal(timeline[0].sourceProvided, true);
  assert.equal(timeline[2].contentChanged, false);
  assert.equal(JSON.stringify(timeline).includes('not a summary'), false);
});

test('formatted timeline is scan-friendly and retains actors, reasons, and status', () => {
  const passport = createPassport();
  passport.dispute('memory-1', { actorAgentId: 'reviewer', reason: 'needs corroboration' });

  const lines = passport.formatTimeline('memory-1').split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^1\. .+ — observer — Created memory; content changed; status: active$/);
  assert.match(lines[1], /^2\. .+ — reviewer — Opened dispute; reason: needs corroboration; status: disputed$/);
});

test('timeline is a defensive derived view', () => {
  const passport = createPassport();
  const timeline = passport.timeline('memory-1');
  timeline[0].summary = 'rewritten';
  assert.equal(passport.timeline('memory-1')[0].summary, 'Created memory');
  assert.equal(passport.history('memory-1')[0].eventType, 'create');
});

test('formatted timeline keeps untrusted metadata on one physical line per event', () => {
  const passport = new MemoryPassport();
  passport.create({ memoryId: 'memory-1', actorAgentId: 'observer\nspoofed:', content: 'v1' });
  passport.dispute('memory-1', {
    actorAgentId: 'reviewer', reason: 'line one\n2. forged event\tline two'
  });

  const formatted = passport.formatTimeline('memory-1');
  assert.equal(formatted.split('\n').length, 2);
  assert.match(formatted, /observer spoofed:/);
  assert.match(formatted, /reason: line one 2\. forged event line two/);
  assert.equal(passport.timeline('memory-1')[1].reason, 'line one\n2. forged event\tline two');
});

test('requestReview opens a review with mandatory independent evidence', () => {
  const passport = createPassport();
  assert.throws(() => passport.requestReview('memory-1', {
    actorAgentId: 'verifier', reason: 'routine verification'
  }), /source/);

  passport.requestReview('memory-1', {
    actorAgentId: 'verifier', reason: 'routine verification',
    source: { resultSequence: 2, check: 'bash -n artifact.sh' }
  });

  const event = passport.history('memory-1')[1];
  assert.equal(event.eventType, 'review');
  assert.deepEqual(event.payload.source, { resultSequence: 2, check: 'bash -n artifact.sh' });
  assert.equal(passport.current('memory-1').status, 'disputed');
  assert.equal(passport.current('memory-1').reviewReason, 'routine verification');
  assert.equal(passport.timeline('memory-1')[1].summary, 'Requested review');
});

test('requestReview preserves the resolve gate and can reopen a resolved memory', () => {
  const passport = createPassport();
  passport.requestReview('memory-1', {
    actorAgentId: 'verifier', reason: 'first review', source: { check: 'record-a' }
  });
  passport.resolve('memory-1', {
    adjudicatorAgentId: 'judge', reason: 'verified', decision: 'accept'
  });
  passport.requestReview('memory-1', {
    actorAgentId: 'verifier-b', reason: 'scheduled recheck', source: { check: 'record-b' }
  });
  assert.deepEqual(passport.history('memory-1').map((event) => event.eventType), [
    'create', 'review', 'resolve', 'review'
  ]);
  assert.equal(passport.timeline('memory-1')[3].summary, 'Requested review again');
  assert.equal(Object.hasOwn(passport.current('memory-1'), 'resolution'), false);
});
