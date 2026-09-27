'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ProjectMemory } = require('./project-memory');

test('package root exports ProjectMemory without changing legacy enumerable exports', () => {
  assert.equal(require('./index').ProjectMemory, ProjectMemory);
});

function memory(projectId = 'project-a') {
  return new ProjectMemory({
    projectId,
    principalId: 'reader',
    authorizedPrincipals: ['reviewer', 'author', 'delegate']
  });
}

function putApproved(store, overrides = {}) {
  const requestedStatus = overrides.status === undefined ? 'approved' : overrides.status;
  const claim = store.putClaim({
    claimId: 'claim-1', subject: 'service', predicate: 'health', content: { state: 'ok' },
    authorId: 'author', provenance: { source: 'probe' }, ...overrides, status: 'candidate'
  });
  if (requestedStatus === 'approved') {
    return store.approveClaim(claim.claimId, { actorId: claim.authorId, reason: 'test fixture review' });
  }
  return claim;
}

test('instances isolate projects and reject a foreign scope', () => {
  const a = memory('project-a');
  const b = memory('project-b');
  putApproved(a);
  assert.equal(b.getClaim('claim-1'), null);
  assert.throws(() => putApproved(b, { claimId: 'foreign', scope: 'organization' }), /scope/);
});

test('candidate claims require opt-in while approved claims are visible', () => {
  const store = memory();
  putApproved(store, { status: 'candidate' });
  assert.equal(store.getClaim('claim-1'), null);
  assert.equal(store.getClaim('claim-1', { includeCandidates: true }).status, 'candidate');
  store.approveClaim('claim-1', { actorId: 'reviewer', reason: 'verified' });
  assert.equal(store.getClaim('claim-1').status, 'approved');
});

test('private claims are limited to author and explicit allowlist', () => {
  const store = memory();
  putApproved(store, { visibility: 'private', allowedPrincipals: ['delegate'] });
  assert.equal(store.getClaim('claim-1', { principalId: 'reader' }), null);
  assert.equal(store.getClaim('claim-1', { principalId: 'author' }).claimId, 'claim-1');
  assert.equal(store.getClaim('claim-1', { principalId: 'delegate' }).claimId, 'claim-1');
  assert.equal(store.getClaim('claim-1', { principalId: 'outsider' }), null);
});

test('writes and lifecycle mutations require authorized principals', () => {
  const store = memory();
  assert.throws(() => putApproved(store, { authorId: 'outsider' }), /authorized/);
  putApproved(store);
  assert.throws(() => store.disputeClaim('claim-1', {
    actorId: 'outsider', reason: 'unauthorized change'
  }), /^Error: claim is unavailable for mutation$/);
  assert.equal(store.getClaim('claim-1').status, 'approved');
});

test('private mutations require both project membership and claim access', () => {
  const store = memory();
  putApproved(store, { visibility: 'private', allowedPrincipals: ['delegate'] });
  assert.throws(() => store.disputeClaim('claim-1', {
    actorId: 'reviewer', reason: 'not private reader'
  }), /^Error: claim is unavailable for mutation$/);
  store.disputeClaim('claim-1', { actorId: 'delegate', reason: 'allowed reviewer' });
  assert.equal(store.getClaim('claim-1', {
    principalId: 'delegate', includeDisputed: true
  }).status, 'disputed');
});

test('project claims require an authorized project principal', () => {
  const store = memory();
  putApproved(store);
  assert.equal(store.getClaim('claim-1', { principalId: 'outsider' }), null);
  assert.equal(store.getClaim('claim-1', { principalId: 'reviewer' }).claimId, 'claim-1');
});

test('candidate writes require explicit provenance', () => {
  const store = memory();
  assert.throws(() => store.putClaim({
    claimId: 'claim-1', subject: 's', predicate: 'p', content: true, authorId: 'author'
  }), /provenance/);
  assert.throws(() => putApproved(store, { provenance: null }), /provenance/);
});

test('new claims are candidate-only and cannot bypass lifecycle transitions', () => {
  const store = memory();
  for (const status of ['approved', 'disputed', 'superseded']) {
    assert.throws(() => store.putClaim({
      claimId: `claim-${status}`, subject: 's', predicate: 'p', content: true,
      authorId: 'author', status, provenance: { source: 'test' }
    }), /putClaim only accepts status=candidate.*direct approved import is unavailable in Phase 1/);
  }
  assert.deepEqual(store.audit(), []);
});

test('approval rejects an expired candidate', () => {
  const store = memory();
  putApproved(store, { status: 'candidate', expiresAt: '2000-01-01T00:00:00.000Z' });
  assert.throws(() => store.approveClaim('claim-1', {
    actorId: 'reviewer', reason: 'too late'
  }), /expired candidate claim cannot be approved/);
  assert.equal(store.history('claim-1').length, 1);
});

test('expired claims are excluded from get and query', () => {
  const store = memory();
  putApproved(store, { status: 'candidate', expiresAt: '2000-01-01T00:00:00.000Z' });
  assert.equal(store.getClaim('claim-1'), null);
  assert.deepEqual(store.query({}), []);
  assert.equal(store.history('claim-1').length, 1);
});

test('dispute and supersession retain lifecycle history and gate reads', () => {
  const store = memory();
  putApproved(store);
  putApproved(store, { claimId: 'claim-2', content: { state: 'degraded' } });
  store.disputeClaim('claim-1', {
    actorId: 'reviewer', reason: 'conflict', evidence: { record: 7 }
  });
  assert.equal(store.getClaim('claim-1'), null);
  assert.equal(store.getClaim('claim-1', { includeDisputed: true }).status, 'disputed');
  store.supersedeClaim('claim-1', {
    actorId: 'reviewer', replacementClaimId: 'claim-2', reason: 'newer observation'
  });
  assert.equal(store.getClaim('claim-1', { includeDisputed: true }), null);
  assert.deepEqual(store.history('claim-1').map((event) => event.action), [
    'put', 'approve', 'dispute', 'supersede'
  ]);
});

test('supersession requires an accessible, approved, unexpired replacement', () => {
  const store = memory();
  putApproved(store, { claimId: 'original' });
  putApproved(store, { claimId: 'candidate', status: 'candidate' });
  assert.throws(() => store.supersedeClaim('original', {
    actorId: 'reviewer', replacementClaimId: 'candidate', reason: 'not reviewed'
  }), /must be approved/);
});

test('supersession rejects unrelated and narrower-audience replacements', () => {
  const store = memory();
  putApproved(store, { claimId: 'original' });
  putApproved(store, { claimId: 'unrelated', predicate: 'owner' });
  assert.throws(() => store.supersedeClaim('original', {
    actorId: 'reviewer', replacementClaimId: 'unrelated', reason: 'wrong relation'
  }), /same subject and predicate/);

  putApproved(store, {
    claimId: 'private-replacement', visibility: 'private', allowedPrincipals: ['reviewer']
  });
  assert.throws(() => store.supersedeClaim('original', {
    actorId: 'reviewer', replacementClaimId: 'private-replacement', reason: 'too narrow'
  }), /audience must include/);
});

test('lifecycle target errors do not disclose existence, visibility, or status before access', () => {
  const store = memory();
  putApproved(store, { claimId: 'public' });
  putApproved(store, { claimId: 'private', visibility: 'private' });
  const unavailable = /^Error: claim is unavailable for mutation$/;

  assert.throws(() => store.approveClaim('missing', {
    actorId: 'reviewer', reason: 'probe'
  }), unavailable);
  assert.throws(() => store.approveClaim('private', {
    actorId: 'reviewer', reason: 'probe'
  }), unavailable);
  assert.throws(() => store.approveClaim('public', {
    actorId: 'outsider', reason: 'probe'
  }), unavailable);
  assert.throws(() => store.approveClaim('missing', {
    actorId: 'outsider', reason: 'probe'
  }), unavailable);

  assert.throws(() => store.approveClaim('public', {
    actorId: 'reviewer', reason: 'second approval'
  }), /only a candidate claim can be approved/);
});

test('supersession does not disclose an inaccessible replacement', () => {
  const store = memory();
  putApproved(store, { claimId: 'original' });
  putApproved(store, { claimId: 'private-replacement', visibility: 'private' });
  const attempt = (replacementClaimId) => store.supersedeClaim('original', {
    actorId: 'reviewer', replacementClaimId, reason: 'probe'
  });
  assert.throws(() => attempt('missing'), /^Error: claim is unavailable for mutation$/);
  assert.throws(() => attempt('private-replacement'), /^Error: claim is unavailable for mutation$/);
});

test('history and audit apply project and private visibility without hiding lifecycle records', () => {
  const store = memory();
  putApproved(store, { claimId: 'public' });
  putApproved(store, {
    claimId: 'secret', visibility: 'private', allowedPrincipals: ['delegate']
  });
  store.disputeClaim('secret', { actorId: 'delegate', reason: 'private conflict' });
  assert.deepEqual(store.history('secret').map((event) => event.action), []);
  assert.deepEqual(store.history('unknown'), []);
  assert.deepEqual(store.history('secret', { principalId: 'delegate' }).map((event) => event.action), [
    'put', 'approve', 'dispute'
  ]);
  assert.deepEqual(store.audit().map((event) => event.claimId), ['public', 'public']);
  assert.deepEqual(store.audit({ principalId: 'delegate' }).map((event) => event.claimId), [
    'public', 'public', 'secret', 'secret', 'secret'
  ]);
});

test('lifecycle audit events record status transitions and replacement context', () => {
  const store = memory();
  putApproved(store, { claimId: 'old', status: 'candidate' });
  putApproved(store, { claimId: 'new' });
  store.approveClaim('old', { actorId: 'reviewer', reason: 'checked' });
  store.supersedeClaim('old', {
    actorId: 'reviewer', replacementClaimId: 'new', reason: 'new observation'
  });
  const events = store.audit();
  const approval = events.find((event) => event.claimId === 'old' && event.action === 'approve');
  const supersession = events.find((event) => event.action === 'supersede');
  assert.deepEqual(
    { fromStatus: approval.fromStatus, toStatus: approval.toStatus },
    { fromStatus: 'candidate', toStatus: 'approved' }
  );
  assert.deepEqual(
    {
      fromStatus: supersession.fromStatus,
      toStatus: supersession.toStatus,
      replacementStatus: supersession.replacementStatus
    },
    { fromStatus: 'approved', toStatus: 'superseded', replacementStatus: 'approved' }
  );
});

test('audit sequence is global and mutation order is append-only', () => {
  const store = memory();
  putApproved(store, { claimId: 'claim-1' });
  putApproved(store, { claimId: 'claim-2' });
  store.disputeClaim('claim-1', { actorId: 'reviewer', reason: 'check again' });
  assert.deepEqual(store.audit().map((event) => event.seq), [1, 2, 3, 4, 5]);
  assert.deepEqual(store.audit().map((event) => event.claimId), [
    'claim-1', 'claim-1', 'claim-2', 'claim-2', 'claim-1'
  ]);
  assert.deepEqual(store.audit().map((event) => event.revision), [1, 2, 1, 2, 3]);
});

test('validateEvents returns a defensive normalized copy of a complete event log', () => {
  const store = memory();
  putApproved(store, { claimId: 'old' });
  putApproved(store, { claimId: 'new' });
  store.supersedeClaim('old', {
    actorId: 'reviewer', replacementClaimId: 'new', reason: 'new observation'
  });
  const source = store.audit();
  const normalized = ProjectMemory.validateEvents(source, { projectId: 'project-a' });
  assert.deepEqual(normalized, source);
  assert.notEqual(normalized, source);
  normalized[0].claim.content.state = 'mutated';
  source[0].claim.content.state = 'source mutation';
  assert.equal(store.history('old')[0].claim.content.state, 'ok');
});

test('validateEvents rejects unsupported event contracts and discontinuous ordering', () => {
  const store = memory();
  putApproved(store);
  const events = store.audit();

  for (const [field, value, pattern] of [
    ['eventSchema', 'unknown/schema', /eventSchema is unsupported/],
    ['eventVersion', 2, /eventVersion is unsupported/],
    ['seq', 3, /seq is discontinuous/],
    ['revision', 3, /revision is discontinuous/]
  ]) {
    const changed = structuredClone(events);
    changed[0][field] = value;
    assert.throws(() => ProjectMemory.validateEvents(changed), pattern);
  }
  assert.throws(
    () => ProjectMemory.validateEvents(events, { projectId: 'another-project' }),
    /projectId does not match the event log/
  );
});

test('validateEvents rejects malformed and impossible lifecycle sequences', () => {
  const store = memory();
  putApproved(store);
  const events = store.audit();

  const missingCreation = structuredClone(events.slice(1));
  missingCreation[0].seq = 1;
  missingCreation[0].revision = 1;
  assert.throws(() => ProjectMemory.validateEvents(missingCreation), /precedes claim creation/);

  const wrongPriorState = structuredClone(events);
  wrongPriorState[1].fromStatus = 'disputed';
  assert.throws(() => ProjectMemory.validateEvents(wrongPriorState), /fromStatus does not match prior state/);

  const malformed = structuredClone(events);
  malformed[0].timestamp = 'not-a-time';
  assert.throws(() => ProjectMemory.validateEvents(malformed), /timestamp must be a valid timestamp/);
});

test('validateEvents errors do not echo private claim identifiers or details', () => {
  const store = memory();
  putApproved(store, {
    claimId: 'private-secret-id', visibility: 'private', content: { secret: 'do-not-echo' }
  });
  const events = store.audit({ principalId: 'author' });
  events[1].revision = 99;
  assert.throws(() => ProjectMemory.validateEvents(events), (error) => {
    assert.doesNotMatch(error.message, /private-secret-id|do-not-echo/);
    return true;
  });
});

test('diagnoseEvents returns a structured valid result and never mutates its input', () => {
  const events = threeEventLog();
  const snapshot = structuredClone(events);
  const result = ProjectMemory.diagnoseEvents(events, { projectId: 'project-a' });
  assert.deepEqual(result, { valid: true, errors: [] });
  assert.deepEqual(events, snapshot);
  assert.deepEqual(ProjectMemory.diagnoseEvents([]), { valid: true, errors: [] });
});

test('diagnoseEvents collects multiple independent errors with stable codes, indexes, seqs, and paths', () => {
  const events = threeEventLog();
  const changed = structuredClone(events);
  changed[0].seq = 9;
  changed[0].timestamp = 'x';
  changed[0].action = 'bogus';
  changed[1].revision = 2.5;
  changed[2].eventSchema = 'nope';

  const expected = [
    { code: 'SEQ_DISCONTINUOUS', message: 'events[0].seq is discontinuous',
      path: 'events[0].seq', index: 0, seq: 9 },
    { code: 'TIMESTAMP_INVALID', message: 'events[0].timestamp must be a valid timestamp string',
      path: 'events[0].timestamp', index: 0, seq: 9 },
    { code: 'ACTION_UNSUPPORTED', message: 'events[0].action is unsupported',
      path: 'events[0].action', index: 0, seq: 9 },
    { code: 'REVISION_INVALID', message: 'events[1].revision must be a positive safe integer',
      path: 'events[1].revision', index: 1, seq: 2 },
    { code: 'EVENT_SCHEMA_UNSUPPORTED', message: 'events[2].eventSchema is unsupported',
      path: 'events[2].eventSchema', index: 2, seq: 3 }
  ];
  const result = ProjectMemory.diagnoseEvents(changed);
  assert.equal(result.valid, false);
  assert.deepEqual(result.errors, expected);
  assert.deepEqual(ProjectMemory.diagnoseEvents(changed), result);
});

test('diagnoseEvents reports lifecycle and state defects with stable codes', () => {
  const store = memory();
  putApproved(store);
  const events = store.audit();

  const missingCreation = structuredClone(events.slice(1));
  missingCreation[0].seq = 1;
  missingCreation[0].revision = 1;
  const precedes = ProjectMemory.diagnoseEvents(missingCreation);
  assert.equal(precedes.errors[0].code, 'ACTION_PRECEDES_CLAIM_CREATION');
  assert.equal(precedes.errors[0].index, 0);

  const wrongPriorState = structuredClone(events);
  wrongPriorState[1].fromStatus = 'disputed';
  const fromStatus = ProjectMemory.diagnoseEvents(wrongPriorState);
  assert.equal(fromStatus.errors[0].code, 'FROM_STATUS_MISMATCH');
  assert.equal(fromStatus.errors[0].index, 1);

  const wrongTarget = structuredClone(events);
  wrongTarget[1].toStatus = 'disputed';
  const transition = ProjectMemory.diagnoseEvents(wrongTarget);
  assert.equal(transition.errors[0].code, 'TRANSITION_INVALID');
  assert.equal(transition.errors[0].index, 1);

  const duplicate = structuredClone(events[0]);
  duplicate.seq = 3;
  duplicate.revision = 3;
  const duplicateResult = ProjectMemory.diagnoseEvents([...events, duplicate]);
  assert.equal(duplicateResult.errors[0].code, 'DUPLICATE_CLAIM_CREATION');
  assert.equal(duplicateResult.errors[0].index, 2);

  const pair = memory();
  putApproved(pair, { claimId: 'old' });
  putApproved(pair, { claimId: 'new' });
  const pairEvents = pair.audit();
  const badReplacement = structuredClone(pairEvents[1]);
  pairEvents.push({ ...badReplacement, seq: 5, revision: 3, action: 'supersede',
    fromStatus: 'approved', toStatus: 'superseded', reason: 'replaced',
    replacementClaimId: 'new', replacementStatus: 'candidate' });
  const replacement = ProjectMemory.diagnoseEvents(pairEvents);
  assert.equal(replacement.errors[0].code, 'SUPERSESSION_REPLACEMENT_INVALID');
  assert.equal(replacement.errors[0].index, 4);

  const unrelatedStore = memory();
  putApproved(unrelatedStore, { claimId: 'old' });
  putApproved(unrelatedStore, { claimId: 'new', predicate: 'latency' });
  const unrelatedEvents = unrelatedStore.audit();
  const supersedeBase = structuredClone(unrelatedEvents[1]);
  unrelatedEvents.push({ ...supersedeBase, seq: 5, revision: 3, action: 'supersede',
    fromStatus: 'approved', toStatus: 'superseded', reason: 'replaced',
    replacementClaimId: 'new', replacementStatus: 'approved' });
  const unrelated = ProjectMemory.diagnoseEvents(unrelatedEvents);
  assert.equal(unrelated.errors[0].code, 'SUPERSESSION_UNRELATED');
  assert.equal(unrelated.errors[0].index, 4);
});

test('diagnoseEvents never echoes private claim identifiers or content', () => {
  const store = memory();
  putApproved(store, {
    claimId: 'private-secret-id', visibility: 'private', content: { secret: 'do-not-echo' }
  });
  const events = store.audit({ principalId: 'author' });
  events[1].revision = 99;
  const result = ProjectMemory.diagnoseEvents(events);
  assert.equal(result.valid, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].code, 'REVISION_DISCONTINUOUS');
  assert.equal(result.errors[0].index, 1);
  assert.equal(result.errors[0].path, 'events[1].revision');
  assert.doesNotMatch(JSON.stringify(result), /private-secret-id|do-not-echo/);
  assert.throws(() => ProjectMemory.validateEvents(events), (error) => {
    assert.equal(result.errors[0].message, error.message);
    return true;
  });
});

test('diagnoseEvents first error matches the validateEvents message boundary for single-defect logs', () => {
  const store = memory();
  putApproved(store);
  const events = store.audit();

  for (const [field, value] of [
    ['eventSchema', 'unknown/schema'],
    ['eventVersion', 2],
    ['seq', 3],
    ['revision', 3],
    ['timestamp', 'not-a-time'],
    ['action', 'bogus']
  ]) {
    const changed = structuredClone(events);
    changed[0][field] = value;
    const result = ProjectMemory.diagnoseEvents(changed);
    assert.equal(result.valid, false);
    assert.equal(result.errors[0].index, 0);
    assert.throws(() => ProjectMemory.validateEvents(changed), (error) => {
      assert.equal(result.errors[0].message, error.message);
      return true;
    });
  }

  const wrongPriorState = structuredClone(events);
  wrongPriorState[1].fromStatus = 'disputed';
  const mismatchResult = ProjectMemory.diagnoseEvents(wrongPriorState);
  assert.equal(mismatchResult.errors[0].index, 1);
  assert.throws(() => ProjectMemory.validateEvents(wrongPriorState), (error) => {
    assert.equal(mismatchResult.errors[0].message, error.message);
    return true;
  });

  const missingCreation = structuredClone(events.slice(1));
  missingCreation[0].seq = 1;
  missingCreation[0].revision = 1;
  const precedesResult = ProjectMemory.diagnoseEvents(missingCreation);
  assert.equal(precedesResult.errors[0].index, 0);
  assert.throws(() => ProjectMemory.validateEvents(missingCreation), (error) => {
    assert.equal(precedesResult.errors[0].message, error.message);
    return true;
  });
});

test('diagnoseEvents survives unparseable and hostile inputs without throwing', () => {
  const store = memory();
  putApproved(store);
  const validEvents = store.audit();

  for (const input of [
    null, undefined, 42, 'events', {}, new Set(), new Map(), function noop() {},
    { length: 2, 0: structuredClone(validEvents[0]) },
    new Date()
  ]) {
    const result = ProjectMemory.diagnoseEvents(input);
    assert.equal(typeof result.valid, 'boolean');
    assert.ok(Array.isArray(result.errors));
    if (result.valid) assert.deepEqual(result.errors, []);
    for (const error of result.errors) {
      assert.equal(typeof error.code, 'string');
      assert.equal(typeof error.message, 'string');
      assert.equal(typeof error.path, 'string');
    }
  }

  const sparseResult = ProjectMemory.diagnoseEvents(new Array(2));
  assert.deepEqual(sparseResult.errors, [
    { code: 'EVENT_SLOT_MISSING', message: 'events[0] is required', path: 'events[0]', index: 0 },
    { code: 'EVENT_SLOT_MISSING', message: 'events[1] is required', path: 'events[1]', index: 1 }
  ]);

  const notRecord = ProjectMemory.diagnoseEvents([1, 'two', null, true]);
  assert.ok(notRecord.errors.every((error) => error.code === 'EVENT_NOT_RECORD'));
  assert.deepEqual(notRecord.errors.map((error) => error.index), [0, 1, 2, 3]);

  const throwingEventsProxy = new Proxy([], {
    get(target, key) {
      if (key === 'length') throw new Error('trap');
      return target[key];
    }
  });
  assert.deepEqual(ProjectMemory.diagnoseEvents(throwingEventsProxy), {
    valid: false,
    errors: [{
      code: 'EVENT_INSPECTION_FAILED', message: 'events could not be inspected safely',
      path: 'events'
    }]
  });

  const withAccessor = structuredClone(validEvents);
  Object.defineProperty(withAccessor[0], 'eventSchema', {
    enumerable: true, get() { throw new Error('boom'); }
  });
  const accessorResult = ProjectMemory.diagnoseEvents(withAccessor);
  assert.ok(accessorResult.errors.some(
    (error) => error.code === 'FIELD_NOT_ENUMERABLE_DATA_PROPERTY'
  ));

  const fromStatusAccessor = structuredClone(validEvents);
  Object.defineProperty(fromStatusAccessor[1], 'fromStatus', {
    enumerable: true, get() { throw new Error('boom'); }
  });
  const fromStatusResult = ProjectMemory.diagnoseEvents(fromStatusAccessor);
  assert.ok(fromStatusResult.errors.some(
    (error) => error.code === 'EVENT_INSPECTION_FAILED'
  ));

  const throwingProxy = new Proxy(structuredClone(validEvents[0]), {
    get() { throw new Error('trap'); }
  });
  assert.doesNotThrow(() => ProjectMemory.diagnoseEvents([throwingProxy]));

  const circular = structuredClone(validEvents[0]);
  circular.claim.content = circular;
  assert.equal(ProjectMemory.diagnoseEvents([circular]).valid, true);

  const bigintEvents = structuredClone(validEvents);
  bigintEvents[0].seq = 1n;
  assert.equal(ProjectMemory.diagnoseEvents(bigintEvents).errors[0].code, 'SEQ_INVALID');

  const symbolKeyEvents = structuredClone(validEvents);
  symbolKeyEvents[0][Symbol('secret')] = 'ignored';
  assert.equal(ProjectMemory.diagnoseEvents(symbolKeyEvents).valid, true);

  assert.equal(ProjectMemory.diagnoseEvents(validEvents, 42).valid, true);
  assert.equal(ProjectMemory.diagnoseEvents(validEvents, null).valid, true);
  assert.equal(
    ProjectMemory.diagnoseEvents(validEvents, { projectId: 42 }).errors[0].code,
    'PROJECT_ID_OPTION_INVALID'
  );
  assert.equal(
    ProjectMemory.diagnoseEvents(validEvents, { projectId: '' }).errors[0].code,
    'PROJECT_ID_OPTION_INVALID'
  );

  const throwingOptionsProxy = new Proxy({}, {
    get(target, key) {
      if (key === 'projectId') throw new Error('trap');
      return target[key];
    }
  });
  const optionsResult = ProjectMemory.diagnoseEvents(validEvents, throwingOptionsProxy);
  assert.equal(optionsResult.valid, false);
  assert.ok(optionsResult.errors.some(
    (error) => error.code === 'EVENT_INSPECTION_FAILED' && error.path === 'options'
  ));
  assert.throws(() => ProjectMemory.validateEvents(validEvents, throwingOptionsProxy));
});

test('diagnoseEvents reports project pinning mismatches and option defects', () => {
  const events = threeEventLog();
  const pinned = ProjectMemory.diagnoseEvents(events, { projectId: 'another-project' });
  assert.equal(pinned.valid, false);
  assert.equal(pinned.errors.length, 3);
  assert.ok(pinned.errors.every((error) => error.code === 'PROJECT_ID_MISMATCH'));
  assert.deepEqual(pinned.errors.map((error) => error.index), [0, 1, 2]);
  assert.deepEqual(pinned.errors.map((error) => error.seq), [1, 2, 3]);
  assert.deepEqual(pinned.errors.map((error) => error.path),
    ['events[0].projectId', 'events[1].projectId', 'events[2].projectId']);
  assert.deepEqual(ProjectMemory.diagnoseEvents(events, { projectId: 'project-a' }),
    { valid: true, errors: [] });
});

test('diagnoseEvents reports invalid claim observedAt/expiresAt timestamps like validateEvents', () => {
  for (const field of ['observedAt', 'expiresAt']) {
    const changed = structuredClone(threeEventLog());
    changed[0].claim[field] = 'not-a-time';
    const result = ProjectMemory.diagnoseEvents(changed);
    assert.equal(result.valid, false);
    assert.equal(result.errors[0].code, 'CLAIM_TIMESTAMP_INVALID');
    assert.equal(result.errors[0].path, `events[0].claim.${field}`);
    assert.equal(result.errors[0].index, 0);
    assert.equal(result.errors[0].seq, 1);
    // downstream event 1 legitimately reports that its claim creation never advanced.
    assert.ok(result.errors.length >= 2);
    assert.throws(() => ProjectMemory.validateEvents(changed), (error) => {
      assert.equal(result.errors[0].message, error.message);
      return true;
    });

    const undefinedField = structuredClone(threeEventLog());
    undefinedField[0].claim[field] = undefined;
    assert.deepEqual(ProjectMemory.diagnoseEvents(undefinedField), { valid: true, errors: [] });
    assert.doesNotThrow(() => ProjectMemory.validateEvents(undefinedField));
  }

  const accessorEvents = structuredClone(threeEventLog());
  Object.defineProperty(accessorEvents[0].claim, 'observedAt', {
    enumerable: true, get() { throw new Error('boom'); }
  });
  const accessorResult = ProjectMemory.diagnoseEvents(accessorEvents);
  assert.equal(accessorResult.valid, false);
  assert.ok(accessorResult.errors.some(
    (error) => error.code === 'EVENT_INSPECTION_FAILED' &&
      error.path === 'events[0].claim.observedAt'
  ));
  assert.throws(() => ProjectMemory.validateEvents(accessorEvents));
});

test('canonicalizeEvents has a stable versioned vector and does not mutate its input', () => {
  const events = [{
    seq: 1,
    eventSchema: 'cairnweave/project-memory-event',
    eventVersion: 1,
    revision: 1,
    timestamp: '2026-01-02T03:04:05.000Z',
    actorId: 'author',
    projectId: 'project-a',
    claimId: 'claim-1',
    action: 'put',
    claim: {
      predicate: 'health',
      subject: 'service',
      projectId: 'project-a',
      claimId: 'claim-1',
      authorId: 'author',
      content: { z: 2, a: [true, null, 'ok'] },
      scope: 'project',
      visibility: 'project',
      status: 'candidate',
      provenance: { source: 'probe' },
      sensitivity: 'normal',
      allowedPrincipals: []
    },
    extension: { '\uE000': 'private-use', '\uD83D\uDE00': 'astral' }
  }];
  const before = structuredClone(events);
  const canonical = ProjectMemory.canonicalizeEvents(events, { projectId: 'project-a' });

  assert.equal(canonical.startsWith(
    '{"canonicalizationSchema":"cairnweave/project-memory-event-log",' +
    '"canonicalizationVersion":1,"events":['
  ), true);
  assert.equal(canonical.includes('"content":{"a":[true,null,"ok"],"z":2}'), true);
  assert.equal(canonical.indexOf('"😀"') < canonical.indexOf('""'), true);
  assert.equal(
    ProjectMemory.computeEventLogDigest(events, { projectId: 'project-a' }),
    'b66607b40b7b9f134619a521ec9ae5deac69ff4c6af50fd532e1f85583bf2830'
  );
  assert.deepEqual(events, before);
});

test('event-log canonicalization rejects non-JSON and silently omitted values', () => {
  const store = memory();
  putApproved(store, { status: 'candidate' });
  const events = store.audit();

  for (const value of [undefined, () => {}, Symbol('value'), NaN, Infinity, new Date(0), 1n]) {
    const malformed = structuredClone(events);
    malformed[0].extension = value;
    assert.throws(() => ProjectMemory.canonicalizeEvents(malformed));
  }

  const symbolKeyed = structuredClone(events);
  symbolKeyed[0][Symbol('hidden')] = true;
  assert.throws(() => ProjectMemory.canonicalizeEvents(symbolKeyed), /symbol key/);

  const sparse = structuredClone(events);
  sparse[0].extension = new Array(1);
  assert.throws(() => ProjectMemory.canonicalizeEvents(sparse), /is required/);
});

test('event-log canonicalization rejects accessor lifecycle fields', () => {
  const store = memory();
  putApproved(store);
  const events = store.audit();

  const accessor = structuredClone(events);
  const reason = accessor[1].reason;
  Object.defineProperty(accessor[1], 'reason', {
    get() { return reason; }, enumerable: true, configurable: true
  });

  assert.doesNotThrow(() => ProjectMemory.validateEvents(accessor));
  assert.throws(
    () => ProjectMemory.canonicalizeEvents(accessor),
    /events\[1\]\.reason must be an enumerable data property/
  );
});

test('event validation rejects inherited, non-enumerable, and accessor required fields', () => {
  const store = memory();
  putApproved(store, { status: 'candidate' });
  const event = store.audit()[0];

  const inherited = structuredClone(event);
  const inheritedSchema = inherited.eventSchema;
  delete inherited.eventSchema;
  Object.setPrototypeOf(inherited, { eventSchema: inheritedSchema });
  assert.throws(() => ProjectMemory.validateEvents([inherited]), /eventSchema is required/);

  const nonEnumerable = structuredClone(event);
  const nonEnumerableSchema = nonEnumerable.eventSchema;
  Object.defineProperty(nonEnumerable, 'eventSchema', {
    value: nonEnumerableSchema, enumerable: false, writable: true, configurable: true
  });
  assert.throws(() => ProjectMemory.validateEvents([nonEnumerable]),
    /eventSchema must be an enumerable data property/);

  const accessor = structuredClone(event);
  const accessorSchema = accessor.eventSchema;
  Object.defineProperty(accessor, 'eventSchema', {
    get() { return accessorSchema; }, enumerable: true, configurable: true
  });
  assert.throws(() => ProjectMemory.validateEvents([accessor]),
    /eventSchema must be an enumerable data property/);

  const inheritedClaim = structuredClone(event);
  const inheritedClaimId = inheritedClaim.claim.claimId;
  delete inheritedClaim.claim.claimId;
  Object.setPrototypeOf(inheritedClaim.claim, { claimId: inheritedClaimId });
  assert.throws(() => ProjectMemory.validateEvents([inheritedClaim]), /claim.claimId is required/);

  const nonEnumerableClaim = structuredClone(event);
  const nonEnumerableClaimId = nonEnumerableClaim.claim.claimId;
  Object.defineProperty(nonEnumerableClaim.claim, 'claimId', {
    value: nonEnumerableClaimId, enumerable: false, writable: true, configurable: true
  });
  assert.throws(() => ProjectMemory.validateEvents([nonEnumerableClaim]),
    /claim.claimId must be an enumerable data property/);

  const accessorClaim = structuredClone(event);
  const accessorClaimId = accessorClaim.claim.claimId;
  Object.defineProperty(accessorClaim.claim, 'claimId', {
    get() { return accessorClaimId; }, enumerable: true, configurable: true
  });
  assert.throws(() => ProjectMemory.validateEvents([accessorClaim]),
    /claim.claimId must be an enumerable data property/);
});

test('event-log digest verification pins projects and reports explicit comparison results', () => {
  const store = memory();
  putApproved(store, { status: 'candidate' });
  const events = store.audit();
  const digest = ProjectMemory.computeEventLogDigest(events, { projectId: 'project-a' });

  assert.equal(ProjectMemory.verifyEventLogDigest(events, digest, {
    projectId: 'project-a'
  }), true);
  assert.equal(ProjectMemory.verifyEventLogDigest(events, '0'.repeat(64), {
    projectId: 'project-a'
  }), false);
  assert.throws(() => ProjectMemory.computeEventLogDigest(events, {
    projectId: 'project-b'
  }), /projectId does not match the event log/);
  assert.throws(() => ProjectMemory.verifyEventLogDigest(events, digest.toUpperCase()),
    /64 lowercase hexadecimal/);
});

test('normalizeAuthorityContext validates and defensively copies a versioned snapshot', () => {
  const source = {
    authoritySchema: 'cairnweave/project-memory-authority-context',
    authorityVersion: 1,
    projectId: 'project-a',
    authorizedPrincipals: ['author', 'reader'],
    privateClaimAudiences: [{
      claimId: 'private-1',
      authorId: 'author',
      allowedPrincipals: ['reader', 'former-reader'],
      extension: { retained: true }
    }],
    extension: { issuer: 'host-application' }
  };
  const normalized = ProjectMemory.normalizeAuthorityContext(source, { projectId: 'project-a' });
  assert.deepEqual(normalized, source);
  assert.notEqual(normalized, source);
  normalized.authorizedPrincipals.push('mutated');
  normalized.privateClaimAudiences[0].extension.retained = false;
  assert.deepEqual(source.authorizedPrincipals, ['author', 'reader']);
  assert.equal(source.privateClaimAudiences[0].extension.retained, true);
});

test('normalizeAuthorityContext rejects unsupported envelopes and project mismatch', () => {
  const context = {
    authoritySchema: 'cairnweave/project-memory-authority-context',
    authorityVersion: 1,
    projectId: 'project-a',
    authorizedPrincipals: ['author'],
    privateClaimAudiences: []
  };
  assert.throws(() => ProjectMemory.normalizeAuthorityContext({
    ...context, authoritySchema: 'unknown/schema'
  }), /authoritySchema is unsupported/);
  assert.throws(() => ProjectMemory.normalizeAuthorityContext({
    ...context, authorityVersion: 2
  }), /authorityVersion is unsupported/);
  assert.throws(
    () => ProjectMemory.normalizeAuthorityContext(context, { projectId: 'project-b' }),
    /projectId does not match the expected project/
  );
});

test('normalizeAuthorityContext rejects duplicate and malformed audience rules', () => {
  const context = {
    authoritySchema: 'cairnweave/project-memory-authority-context',
    authorityVersion: 1,
    projectId: 'project-a',
    authorizedPrincipals: ['author', 'reader'],
    privateClaimAudiences: [{
      claimId: 'private-1', authorId: 'author', allowedPrincipals: ['reader']
    }]
  };
  assert.throws(() => ProjectMemory.normalizeAuthorityContext({
    ...context, authorizedPrincipals: ['author', 'author']
  }), /duplicates a principal/);
  assert.throws(() => ProjectMemory.normalizeAuthorityContext({
    ...context,
    privateClaimAudiences: [...context.privateClaimAudiences, {
      claimId: 'private-1', authorId: 'author', allowedPrincipals: []
    }]
  }), /duplicates or conflicts/);
  assert.throws(() => ProjectMemory.normalizeAuthorityContext({
    ...context,
    privateClaimAudiences: [{
      claimId: 'private-1', authorId: 'author', allowedPrincipals: ['reader', 'reader']
    }]
  }), /duplicates a principal/);
  assert.throws(() => ProjectMemory.normalizeAuthorityContext({
    ...context,
    privateClaimAudiences: [{
      claimId: 'private-1', authorId: 'author', allowedPrincipals: ['author']
    }]
  }), /conflicts with authorId/);
  assert.throws(() => ProjectMemory.normalizeAuthorityContext({
    ...context,
    privateClaimAudiences: [{
      claimId: 'private-1', authorId: 'outsider', allowedPrincipals: []
    }]
  }), /authorId is not an authorized project principal/);
  assert.throws(() => ProjectMemory.normalizeAuthorityContext({
    ...context,
    privateClaimAudiences: [{ claimId: 'private-1', authorId: 'author' }]
  }), /allowedPrincipals is required/);
});

test('private audiences do not promote principals into project authorization', () => {
  const normalized = ProjectMemory.normalizeAuthorityContext({
    authoritySchema: 'cairnweave/project-memory-authority-context',
    authorityVersion: 1,
    projectId: 'project-a',
    authorizedPrincipals: ['author'],
    privateClaimAudiences: [{
      claimId: 'private-1', authorId: 'author', allowedPrincipals: ['outsider']
    }]
  });
  assert.deepEqual(normalized.authorizedPrincipals, ['author']);
  assert.deepEqual(normalized.privateClaimAudiences[0].allowedPrincipals, ['outsider']);
});

test('normalizeBoundAuthorityContext binds a defensive snapshot to an inclusive event range', () => {
  const source = {
    authoritySchema: 'cairnweave/project-memory-authority-context',
    authorityVersion: 1,
    authorityContextId: 'authority-snapshot-7',
    projectId: 'project-a',
    fromSeq: 2,
    toSeq: 7,
    authorizedPrincipals: ['author', 'reader'],
    privateClaimAudiences: [{
      claimId: 'private-1', authorId: 'author', allowedPrincipals: ['reader'],
      extension: { retained: true }
    }],
    extension: { issuer: 'host-application' }
  };
  const normalized = ProjectMemory.normalizeBoundAuthorityContext(source, {
    projectId: 'project-a'
  });
  assert.deepEqual(normalized, source);
  assert.notEqual(normalized, source);
  normalized.extension.issuer = 'mutated';
  normalized.privateClaimAudiences[0].allowedPrincipals.push('mutated');
  assert.equal(source.extension.issuer, 'host-application');
  assert.deepEqual(source.privateClaimAudiences[0].allowedPrincipals, ['reader']);
});

test('normalizeBoundAuthorityContext rejects missing, malformed, and reversed coverage', () => {
  const context = {
    authoritySchema: 'cairnweave/project-memory-authority-context',
    authorityVersion: 1,
    authorityContextId: 'authority-snapshot-7',
    projectId: 'project-a',
    fromSeq: 1,
    toSeq: 3,
    authorizedPrincipals: ['author'],
    privateClaimAudiences: []
  };
  for (const field of ['authorityContextId', 'fromSeq', 'toSeq']) {
    const malformed = { ...context };
    delete malformed[field];
    assert.throws(
      () => ProjectMemory.normalizeBoundAuthorityContext(malformed),
      new RegExp(`${field} is required`)
    );
  }
  for (const [field, value] of [['fromSeq', 0], ['fromSeq', 1.5], ['toSeq', '3']]) {
    assert.throws(
      () => ProjectMemory.normalizeBoundAuthorityContext({ ...context, [field]: value }),
      new RegExp(`${field} must be a positive safe integer`)
    );
  }
  assert.throws(
    () => ProjectMemory.normalizeBoundAuthorityContext({ ...context, fromSeq: 4 }),
    /fromSeq must be less than or equal to context\.toSeq/
  );
  assert.throws(
    () => ProjectMemory.normalizeBoundAuthorityContext({ ...context, projectId: 'project-b' }, {
      projectId: 'project-a'
    }),
    /projectId does not match the expected project/
  );
  assert.deepEqual(
    ProjectMemory.normalizeBoundAuthorityContext({ ...context, coverageMode: 'closed' }),
    { ...context, coverageMode: 'closed' }
  );
  for (const coverageMode of ['open', 'latest', 'half-open', null]) {
    assert.throws(
      () => ProjectMemory.normalizeBoundAuthorityContext({ ...context, coverageMode }),
      /coverageMode must be 'closed'/
    );
  }
});

test('normalizeBoundAuthorityContext preserves explicit self-contained revision lineage', () => {
  const source = {
    authoritySchema: 'cairnweave/project-memory-authority-context',
    authorityVersion: 1,
    authorityContextId: 'authority-snapshot-2',
    projectId: 'project-a',
    fromSeq: 4,
    toSeq: 9,
    authorizedPrincipals: ['author'],
    privateClaimAudiences: [],
    supersedes: {
      authorityContextId: 'authority-snapshot-1',
      projectId: 'project-a',
      fromSeq: 4,
      toSeq: 9
    }
  };
  const normalized = ProjectMemory.normalizeBoundAuthorityContext(source);
  assert.deepEqual(normalized, source);
  normalized.supersedes.authorityContextId = 'mutated';
  assert.equal(source.supersedes.authorityContextId, 'authority-snapshot-1');
});

test('authority snapshot revision lineage requires a distinct ID and identical project and range', () => {
  const context = {
    authoritySchema: 'cairnweave/project-memory-authority-context',
    authorityVersion: 1,
    authorityContextId: 'authority-snapshot-2',
    projectId: 'project-a',
    fromSeq: 4,
    toSeq: 9,
    authorizedPrincipals: ['author'],
    privateClaimAudiences: []
  };
  const supersedes = {
    authorityContextId: 'authority-snapshot-1',
    projectId: 'project-a',
    fromSeq: 4,
    toSeq: 9
  };
  for (const field of ['authorityContextId', 'projectId', 'fromSeq', 'toSeq']) {
    const malformed = { ...supersedes };
    delete malformed[field];
    assert.throws(
      () => ProjectMemory.normalizeBoundAuthorityContext({ ...context, supersedes: malformed }),
      new RegExp(`supersedes\\.${field} is required`)
    );
  }
  assert.throws(() => ProjectMemory.normalizeBoundAuthorityContext({
    ...context, supersedes: { ...supersedes, authorityContextId: context.authorityContextId }
  }), /must identify a different snapshot/);
  assert.throws(() => ProjectMemory.normalizeBoundAuthorityContext({
    ...context, supersedes: { ...supersedes, projectId: 'project-b' }
  }), /projectId must match/);
  assert.throws(() => ProjectMemory.normalizeBoundAuthorityContext({
    ...context, supersedes: { ...supersedes, fromSeq: 3 }
  }), /range must match/);
  assert.throws(() => ProjectMemory.normalizeBoundAuthorityContext({
    ...context, supersedes: { ...supersedes, toSeq: 10 }
  }), /range must match/);
  for (const malformed of [[], [supersedes], null, 'authority-snapshot-1']) {
    assert.throws(
      () => ProjectMemory.normalizeBoundAuthorityContext({ ...context, supersedes: malformed }),
      /context\.supersedes must be an object/
    );
  }
});

test('normalizeAuthorityContextLineage validates a self-contained linear revision chain', () => {
  const base = {
    authoritySchema: 'cairnweave/project-memory-authority-context',
    authorityVersion: 1,
    projectId: 'project-a',
    fromSeq: 4,
    toSeq: 9,
    authorizedPrincipals: ['author'],
    privateClaimAudiences: []
  };
  const target = (authorityContextId) => ({
    authorityContextId, projectId: 'project-a', fromSeq: 4, toSeq: 9
  });
  const source = [
    { ...base, authorityContextId: 'snapshot-1' },
    { ...base, authorityContextId: 'snapshot-2', supersedes: target('snapshot-1') },
    { ...base, authorityContextId: 'snapshot-3', supersedes: target('snapshot-2') }
  ];

  const normalized = ProjectMemory.normalizeAuthorityContextLineage(source, {
    projectId: 'project-a'
  });
  assert.deepEqual(normalized, source);
  normalized[1].supersedes.authorityContextId = 'mutated';
  assert.equal(source[1].supersedes.authorityContextId, 'snapshot-1');
  assert.deepEqual(ProjectMemory.normalizeAuthorityContextLineage([]), []);
});

test('normalizeAuthorityContextLineage rejects incomplete, conflicting, and cyclic links', () => {
  const base = {
    authoritySchema: 'cairnweave/project-memory-authority-context',
    authorityVersion: 1,
    projectId: 'project-a',
    fromSeq: 1,
    toSeq: 3,
    authorizedPrincipals: ['author'],
    privateClaimAudiences: []
  };
  const target = (authorityContextId, extension = {}) => ({
    authorityContextId, projectId: 'project-a', fromSeq: 1, toSeq: 3, ...extension
  });
  const snapshot = (authorityContextId, supersedes) => ({
    ...base, authorityContextId, ...(supersedes ? { supersedes } : {})
  });

  assert.throws(() => ProjectMemory.normalizeAuthorityContextLineage([
    snapshot('snapshot-2', target('snapshot-1'))
  ]), /target is absent from the lineage set/);
  assert.throws(() => ProjectMemory.normalizeAuthorityContextLineage([
    snapshot('snapshot-1'),
    snapshot('snapshot-2', target('snapshot-1')),
    snapshot('snapshot-3', target('snapshot-1'))
  ]), /target has multiple successors/);
  assert.throws(() => ProjectMemory.normalizeAuthorityContextLineage([
    snapshot('snapshot-1', target('snapshot-2')),
    snapshot('snapshot-2', target('snapshot-1'))
  ]), /contains a cycle/);
  assert.throws(() => ProjectMemory.normalizeAuthorityContextLineage([
    snapshot('snapshot-1'),
    snapshot('snapshot-2', target('snapshot-1')),
    snapshot('snapshot-2')
  ]), /authorityContextId is duplicated/);
  assert.throws(() => ProjectMemory.normalizeAuthorityContextLineage({}),
    /contexts must be an array/);
  assert.throws(() => ProjectMemory.normalizeAuthorityContextLineage(new Array(1)),
    /contexts\[0\] is required/);
});

test('normalizeAuthorityContextChain requires one connected revision chain', () => {
  const base = {
    authoritySchema: 'cairnweave/project-memory-authority-context',
    authorityVersion: 1,
    projectId: 'project-a',
    fromSeq: 1,
    toSeq: 3,
    authorizedPrincipals: ['author'],
    privateClaimAudiences: []
  };
  const target = (authorityContextId) => ({
    authorityContextId, projectId: 'project-a', fromSeq: 1, toSeq: 3
  });
  const source = [
    { ...base, authorityContextId: 'snapshot-2', supersedes: target('snapshot-1') },
    { ...base, authorityContextId: 'snapshot-1' }
  ];

  const normalized = ProjectMemory.normalizeAuthorityContextChain(source);
  assert.deepEqual(normalized, source);
  normalized[0].supersedes.authorityContextId = 'mutated';
  assert.equal(source[0].supersedes.authorityContextId, 'snapshot-1');
  assert.deepEqual(ProjectMemory.normalizeAuthorityContextChain([]), []);

  const independentChains = [
    ...source,
    { ...base, authorityContextId: 'unrelated-root' }
  ];
  assert.deepEqual(
    ProjectMemory.normalizeAuthorityContextLineage(independentChains),
    independentChains
  );
  assert.throws(() => ProjectMemory.normalizeAuthorityContextChain(independentChains),
    /must contain exactly one root/);
});

test('normalizeAuthorityContextRanges canonicalizes contiguous closed ranges', () => {
  const context = {
    authoritySchema: 'cairnweave/project-memory-authority-context',
    authorityVersion: 1,
    projectId: 'project-a',
    authorizedPrincipals: ['author'],
    privateClaimAudiences: [],
    coverageMode: 'closed'
  };
  const source = [
    { ...context, authorityContextId: 'snapshot-2', fromSeq: 3, toSeq: 5 },
    { ...context, authorityContextId: 'snapshot-1', fromSeq: 1, toSeq: 2 }
  ];
  const normalized = ProjectMemory.normalizeAuthorityContextRanges(source, {
    projectId: 'project-a'
  });
  assert.deepEqual(normalized.map(({ authorityContextId }) => authorityContextId), [
    'snapshot-1', 'snapshot-2'
  ]);
  normalized[0].authorizedPrincipals.push('mutated');
  assert.deepEqual(source[1].authorizedPrincipals, ['author']);
  assert.deepEqual(ProjectMemory.normalizeAuthorityContextRanges([]), []);
});

test('normalizeAuthorityContextRanges rejects ambiguous range sets', () => {
  const context = {
    authoritySchema: 'cairnweave/project-memory-authority-context',
    authorityVersion: 1,
    projectId: 'project-a',
    authorizedPrincipals: ['author'],
    privateClaimAudiences: []
  };
  const range = (authorityContextId, fromSeq, toSeq, extension = {}) => ({
    ...context, authorityContextId, fromSeq, toSeq, ...extension
  });

  assert.throws(() => ProjectMemory.normalizeAuthorityContextRanges([
    range('snapshot-1', 1, 3), range('snapshot-2', 3, 4)
  ]), /overlaps the preceding authority range/);
  assert.throws(() => ProjectMemory.normalizeAuthorityContextRanges([
    range('snapshot-1', 1, 2), range('snapshot-2', 4, 5)
  ]), /leaves a gap after the preceding authority range/);
  assert.throws(() => ProjectMemory.normalizeAuthorityContextRanges([
    range('snapshot-1', 1, 2), range('snapshot-1', 3, 4)
  ]), /authorityContextId is duplicated/);
  assert.throws(() => ProjectMemory.normalizeAuthorityContextRanges([
    range('snapshot-1', 1, 2),
    range('snapshot-2', 3, 4, { projectId: 'project-b' })
  ]), /projectId does not match the authority range set/);
  assert.throws(
    () => ProjectMemory.normalizeAuthorityContextRanges({}),
    /contexts must be an array/
  );
  assert.throws(
    () => ProjectMemory.normalizeAuthorityContextRanges(new Array(1)),
    /contexts\[0\] is required/
  );
});

test('normalizeAuthorityContextRanges distinguishes complete coverage from a partial excerpt', () => {
  const context = {
    authoritySchema: 'cairnweave/project-memory-authority-context',
    authorityVersion: 1,
    projectId: 'project-a',
    authorizedPrincipals: ['author'],
    privateClaimAudiences: []
  };
  const range = (authorityContextId, fromSeq, toSeq, coverageIntent) => ({
    ...context, authorityContextId, fromSeq, toSeq, coverageIntent
  });

  const complete = ProjectMemory.normalizeAuthorityContextRanges([
    range('snapshot-2', 3, 5, 'complete'),
    range('snapshot-1', 1, 2, 'complete')
  ]);
  assert.deepEqual(complete.map(({ authorityContextId, coverageIntent }) => ({
    authorityContextId, coverageIntent
  })), [
    { authorityContextId: 'snapshot-1', coverageIntent: 'complete' },
    { authorityContextId: 'snapshot-2', coverageIntent: 'complete' }
  ]);

  const partial = ProjectMemory.normalizeAuthorityContextRanges([
    range('snapshot-7', 7, 9, 'partial')
  ]);
  assert.equal(partial[0].coverageIntent, 'partial');
});

test('authority range coverageIntent is strict and complete coverage starts at seq 1', () => {
  const base = {
    authoritySchema: 'cairnweave/project-memory-authority-context',
    authorityVersion: 1,
    projectId: 'project-a',
    authorizedPrincipals: ['author'],
    privateClaimAudiences: []
  };
  const range = (authorityContextId, fromSeq, toSeq, extension = {}) => ({
    ...base, authorityContextId, fromSeq, toSeq, ...extension
  });

  assert.throws(() => ProjectMemory.normalizeBoundAuthorityContext(
    range('snapshot-1', 1, 2, { coverageIntent: 'unknown' })
  ), /coverageIntent must be 'complete' or 'partial'/);
  assert.throws(() => ProjectMemory.normalizeAuthorityContextRanges([
    range('snapshot-1', 2, 3, { coverageIntent: 'complete' })
  ]), /complete authority range set must start at seq 1/);
  assert.throws(() => ProjectMemory.normalizeAuthorityContextRanges([
    range('snapshot-1', 1, 2, { coverageIntent: 'complete' }),
    range('snapshot-2', 3, 4)
  ]), /coverageIntent must be declared on every range/);
  assert.throws(() => ProjectMemory.normalizeAuthorityContextRanges([
    range('snapshot-1', 1, 2, { coverageIntent: 'complete' }),
    range('snapshot-2', 3, 4, { coverageIntent: 'partial' })
  ]), /coverageIntent must be consistent/);
});

test('normalizeBoundAuthorityContext rejects claim content but preserves other extensions', () => {
  const context = {
    authoritySchema: 'cairnweave/project-memory-authority-context',
    authorityVersion: 1,
    authorityContextId: 'authority-snapshot-1',
    projectId: 'project-a',
    fromSeq: 1,
    toSeq: 1,
    authorizedPrincipals: ['author'],
    privateClaimAudiences: [{
      claimId: 'private-1', authorId: 'author', allowedPrincipals: [], note: 'extension retained'
    }]
  };
  assert.equal(
    ProjectMemory.normalizeBoundAuthorityContext(context).privateClaimAudiences[0].note,
    'extension retained'
  );
  for (const field of ['claim', 'claims', 'content', 'claimContent', 'claimContents']) {
    assert.throws(
      () => ProjectMemory.normalizeBoundAuthorityContext({ ...context, [field]: {} }),
      /unsupported in an authority snapshot/
    );
  }
  assert.throws(() => ProjectMemory.normalizeBoundAuthorityContext({
    ...context,
    privateClaimAudiences: [{ ...context.privateClaimAudiences[0], claimContent: 'secret' }]
  }), /unsupported claim content/);
});

test('normalizeBoundAuthorityContext accepts and defensively copies caller-supplied event digest metadata', () => {
  const context = {
    authoritySchema: 'cairnweave/project-memory-authority-context',
    authorityVersion: 1,
    authorityContextId: 'authority-snapshot-1',
    projectId: 'project-a',
    fromSeq: 1,
    toSeq: 3,
    authorizedPrincipals: ['author'],
    privateClaimAudiences: [],
    eventLogDigest: {
      algorithm: 'sha256',
      digest: '0123456789abcdef'.repeat(4),
      extension: { canonicalization: 'adapter-defined' }
    }
  };
  const normalized = ProjectMemory.normalizeBoundAuthorityContext(context);
  assert.deepEqual(normalized, context);
  assert.notEqual(normalized.eventLogDigest, context.eventLogDigest);
  normalized.eventLogDigest.extension.canonicalization = 'mutated';
  assert.equal(context.eventLogDigest.extension.canonicalization, 'adapter-defined');

  const withoutDigest = structuredClone(context);
  delete withoutDigest.eventLogDigest;
  assert.deepEqual(ProjectMemory.normalizeBoundAuthorityContext(withoutDigest), withoutDigest);
});

test('normalizeBoundAuthorityContext rejects malformed event digest metadata and claim payload', () => {
  const context = {
    authoritySchema: 'cairnweave/project-memory-authority-context',
    authorityVersion: 1,
    authorityContextId: 'authority-snapshot-1',
    projectId: 'project-a',
    fromSeq: 1,
    toSeq: 3,
    authorizedPrincipals: ['author'],
    privateClaimAudiences: []
  };
  for (const eventLogDigest of [null, [], 'sha256:digest']) {
    assert.throws(
      () => ProjectMemory.normalizeBoundAuthorityContext({ ...context, eventLogDigest }),
      /eventLogDigest must be an object/
    );
  }
  assert.throws(() => ProjectMemory.normalizeBoundAuthorityContext({
    ...context, eventLogDigest: { digest: '0'.repeat(64) }
  }), /algorithm is required/);
  assert.throws(() => ProjectMemory.normalizeBoundAuthorityContext({
    ...context, eventLogDigest: { algorithm: 'sha256' }
  }), /digest is required/);
  assert.throws(() => ProjectMemory.normalizeBoundAuthorityContext({
    ...context, eventLogDigest: { algorithm: 'sha512', digest: '0'.repeat(64) }
  }), /algorithm is unsupported/);
  for (const digest of ['0'.repeat(63), '0'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), 123]) {
    assert.throws(() => ProjectMemory.normalizeBoundAuthorityContext({
      ...context, eventLogDigest: { algorithm: 'sha256', digest }
    }), /digest must be exactly 64 lowercase hexadecimal characters/);
  }
  assert.throws(() => ProjectMemory.normalizeBoundAuthorityContext({
    ...context,
    eventLogDigest: { algorithm: 'sha256', digest: '0'.repeat(64), claim: {} }
  }), /eventLogDigest contains unsupported claim content/);
});

test('injected clock makes expiry boundaries and event timestamps deterministic', () => {
  let current = new Date('2030-01-01T00:00:00.000Z');
  const store = new ProjectMemory({
    projectId: 'project-a',
    principalId: 'reader',
    authorizedPrincipals: ['reviewer', 'author'],
    clock: () => current
  });
  putApproved(store, {
    status: 'candidate', expiresAt: '2030-01-01T00:00:01.000Z'
  });
  assert.equal(store.history('claim-1')[0].timestamp, '2030-01-01T00:00:00.000Z');
  assert.equal(store.getClaim('claim-1', { includeCandidates: true }).claimId, 'claim-1');

  current = new Date('2030-01-01T00:00:01.000Z');
  assert.equal(store.getClaim('claim-1', { includeCandidates: true }), null);
  assert.throws(() => store.approveClaim('claim-1', {
    actorId: 'reviewer', reason: 'at the exclusive boundary'
  }), /expired candidate claim cannot be approved/);

  current = new Date('2030-01-01T00:00:02.000Z');
  store.disputeClaim('claim-1', { actorId: 'reviewer', reason: 'retained history' });
  assert.equal(store.history('claim-1')[1].timestamp, '2030-01-01T00:00:02.000Z');
});

test('each operation takes one clock snapshot and events carry stable metadata', () => {
  let calls = 0;
  const store = new ProjectMemory({
    projectId: 'project-a',
    principalId: 'reader',
    authorizedPrincipals: ['author'],
    clock: () => {
      calls += 1;
      return new Date(`2030-01-01T00:00:0${calls}.000Z`);
    }
  });
  putApproved(store, { status: 'candidate' });
  assert.equal(calls, 1);
  store.query({ includeCandidates: true });
  assert.equal(calls, 2);
  store.approveClaim('claim-1', { actorId: 'author', reason: 'reviewed' });
  assert.equal(calls, 3);
  assert.deepEqual(store.audit().map(({ eventSchema, eventVersion, timestamp }) => ({
    eventSchema, eventVersion, timestamp
  })), [
    {
      eventSchema: 'cairnweave/project-memory-event',
      eventVersion: 1,
      timestamp: '2030-01-01T00:00:01.000Z'
    },
    {
      eventSchema: 'cairnweave/project-memory-event',
      eventVersion: 1,
      timestamp: '2030-01-01T00:00:03.000Z'
    }
  ]);
});

test('invalid clocks fail before a claim or lifecycle mutation is committed', () => {
  const store = new ProjectMemory({
    projectId: 'project-a',
    principalId: 'author',
    authorizedPrincipals: ['author'],
    clock: () => new Date('invalid')
  });
  assert.throws(() => putApproved(store, { status: 'candidate' }), /clock must return a valid Date/);
  assert.deepEqual(store.audit(), []);
  assert.equal(store.history('claim-1').length, 0);
  assert.throws(() => new ProjectMemory({ projectId: 'project-a', clock: 1 }), /clock must be a function/);
});

test('inputs, claims, evidence, histories, and audit results are defensive copies', () => {
  const store = memory();
  const content = { nested: { value: 'original' } };
  const provenance = { nested: { source: 'original' } };
  putApproved(store, { content, provenance });
  content.nested.value = 'changed';
  provenance.nested.source = 'changed';
  const evidence = { nested: { value: 'original' } };
  store.disputeClaim('claim-1', { actorId: 'reviewer', reason: 'conflict', evidence });
  evidence.nested.value = 'changed';
  const claim = store.getClaim('claim-1', { includeDisputed: true });
  const history = store.history('claim-1');
  const audit = store.audit();
  claim.content.nested.value = 'returned mutation';
  history[0].claim.content.nested.value = 'history mutation';
  audit.find((event) => event.action === 'dispute').evidence.nested.value = 'audit mutation';
  assert.equal(store.getClaim('claim-1', { includeDisputed: true }).content.nested.value, 'original');
  assert.equal(store.getClaim('claim-1', { includeDisputed: true }).provenance.nested.source, 'original');
  assert.equal(store.history('claim-1').find((event) => event.action === 'dispute').evidence.nested.value, 'original');
});

test('invalid project, claim, principal, and actor IDs are rejected', () => {
  assert.throws(() => new ProjectMemory({ projectId: '' }), /projectId/);
  assert.throws(() => new ProjectMemory({ projectId: 'p', principalId: ' ' }), /principalId/);
  const store = memory();
  assert.throws(() => putApproved(store, { claimId: '' }), /claimId/);
  assert.throws(() => putApproved(store, { authorId: '' }), /authorId/);
  putApproved(store);
  assert.throws(() => store.approveClaim('claim-1', { actorId: '', reason: 'x' }), /actorId/);
  assert.throws(() => store.getClaim('claim-1', { principalId: '' }), /principalId/);
});

test('query filters subject and predicate without exposing candidates or disputes', () => {
  const store = memory();
  putApproved(store, { claimId: 'one', subject: 'a', predicate: 'state' });
  putApproved(store, { claimId: 'two', subject: 'b', predicate: 'state', status: 'candidate' });
  putApproved(store, { claimId: 'three', subject: 'a', predicate: 'owner' });
  assert.deepEqual(store.query({ subject: 'a' }).map((claim) => claim.claimId), ['one', 'three']);
  assert.deepEqual(store.query({ predicate: 'state' }).map((claim) => claim.claimId), ['one']);
});

function threeEventLog(projectId = 'project-a') {
  const store = new ProjectMemory({
    projectId,
    principalId: 'reader',
    authorizedPrincipals: ['reviewer', 'author'],
    clock: () => new Date('2026-01-02T03:04:05.000Z')
  });
  store.putClaim({
    claimId: 'claim-1', subject: 'service', predicate: 'health', content: { state: 'ok' },
    authorId: 'author', provenance: { source: 'probe', resultSequence: 1 }
  });
  store.approveClaim('claim-1', { actorId: 'reviewer', reason: 'checked' });
  store.putClaim({
    claimId: 'claim-2', subject: 'service', predicate: 'latency', content: { p99: 120 },
    authorId: 'author', provenance: { source: 'probe', resultSequence: 2 }
  });
  return store.audit();
}

function authoritySnapshot({ fromSeq, toSeq, digest }) {
  return {
    authoritySchema: 'cairnweave/project-memory-authority-context',
    authorityVersion: 1,
    authorityContextId: 'authority-snapshot-1',
    projectId: 'project-a',
    fromSeq,
    toSeq,
    authorizedPrincipals: ['author', 'reviewer'],
    privateClaimAudiences: [],
    ...(digest === undefined ? {} : { eventLogDigest: { algorithm: 'sha256', digest } })
  };
}

test('computeEventLogRangeDigest preserves the full-log vector and covers a closed inclusive range', () => {
  const events = threeEventLog();
  assert.equal(
    ProjectMemory.computeEventLogRangeDigest(events, 1, 3, { projectId: 'project-a' }),
    ProjectMemory.computeEventLogDigest(events, { projectId: 'project-a' })
  );
  // Cross-runtime vectors: stable canonical bytes for a deterministic three-event log.
  assert.equal(
    ProjectMemory.computeEventLogRangeDigest(events, 1, 3, { projectId: 'project-a' }),
    'ec1a9f6359a216192415048753390817a751e21358055d443b43ff9dbf349e2a'
  );
  assert.equal(
    ProjectMemory.computeEventLogRangeDigest(events, 2, 3, { projectId: 'project-a' }),
    '3a60cda9ac5f9e0742743c1e8eedc1507a6aaedf84c25524dd38dcd0d5c034fd'
  );
  assert.equal(
    ProjectMemory.computeEventLogRangeDigest(events, 3, 3, { projectId: 'project-a' }),
    'f7bc5bfbae662ce216dcd1cf891fe57268b7519a2089c22477553d645687243a'
  );
  assert.throws(() => ProjectMemory.computeEventLogRangeDigest(events, 2, 1),
    /fromSeq must be less than or equal to toSeq/);
  assert.throws(() => ProjectMemory.computeEventLogRangeDigest(events, 0, 1),
    /fromSeq must be a positive safe integer/);
  assert.throws(() => ProjectMemory.computeEventLogRangeDigest(events, 1, 1.5),
    /toSeq must be a positive safe integer/);
  assert.throws(() => ProjectMemory.computeEventLogRangeDigest(events, 1, 4),
    /toSeq exceeds the event log length/);
  assert.throws(() => ProjectMemory.computeEventLogRangeDigest(events, 1, 3, {
    projectId: 'project-b'
  }), /projectId does not match the event log/);
});

test('range digests apply the same canonical-JSON boundary and do not mutate inputs', () => {
  const events = threeEventLog();
  const before = structuredClone(events);
  assert.equal(
    ProjectMemory.computeEventLogRangeDigest(events, 2, 3, { projectId: 'project-a' }),
    '3a60cda9ac5f9e0742743c1e8eedc1507a6aaedf84c25524dd38dcd0d5c034fd'
  );
  assert.deepEqual(events, before);

  const symbolKeyed = structuredClone(events);
  symbolKeyed[1][Symbol('hidden')] = true;
  assert.throws(() => ProjectMemory.computeEventLogRangeDigest(symbolKeyed, 1, 3),
    /symbol key/);
});

test('verifyAuthorityContextEventLog verifies a bound snapshot against a concrete log', () => {
  const events = threeEventLog();
  const partialDigest = ProjectMemory.computeEventLogRangeDigest(events, 2, 3, {
    projectId: 'project-a'
  });
  const result = ProjectMemory.verifyAuthorityContextEventLog(
    authoritySnapshot({ fromSeq: 2, toSeq: 3, digest: partialDigest }),
    events, { projectId: 'project-a' }
  );
  assert.deepEqual(result, {
    valid: true,
    range: { fromSeq: 2, toSeq: 3, eventCount: 3, withinLog: true },
    digest: { algorithm: 'sha256', verified: true }
  });

  const fullDigest = ProjectMemory.computeEventLogDigest(events, { projectId: 'project-a' });
  assert.equal(ProjectMemory.verifyAuthorityContextEventLog(
    authoritySnapshot({ fromSeq: 1, toSeq: 3, digest: fullDigest }),
    events, { projectId: 'project-a' }
  ).valid, true);
});

test('verifyAuthorityContextEventLog reports coverage and digest mismatches as a consumable result', () => {
  const events = threeEventLog();
  const digest = ProjectMemory.computeEventLogRangeDigest(events, 2, 3, {
    projectId: 'project-a'
  });

  const outOfRange = ProjectMemory.verifyAuthorityContextEventLog(
    authoritySnapshot({ fromSeq: 1, toSeq: 9, digest }),
    events, { projectId: 'project-a' }
  );
  assert.equal(outOfRange.valid, false);
  assert.deepEqual(outOfRange.range, { fromSeq: 1, toSeq: 9, eventCount: 3, withinLog: false });
  assert.deepEqual(outOfRange.digest, { algorithm: 'sha256', verified: false });
  assert.match(outOfRange.errors[0], /toSeq exceeds the event log length/);

  const wrongDigest = ProjectMemory.verifyAuthorityContextEventLog(
    authoritySnapshot({ fromSeq: 2, toSeq: 3, digest: '0'.repeat(64) }),
    events, { projectId: 'project-a' }
  );
  assert.equal(wrongDigest.valid, false);
  assert.equal(wrongDigest.digest.verified, false);
  assert.match(wrongDigest.errors[0], /does not match the covered event range/);

  const rangeOnly = ProjectMemory.verifyAuthorityContextEventLog(
    authoritySnapshot({ fromSeq: 1, toSeq: 3 }),
    events, { projectId: 'project-a' }
  );
  assert.deepEqual(rangeOnly, { valid: true, range: { fromSeq: 1, toSeq: 3, eventCount: 3, withinLog: true } });

  const emptyLog = ProjectMemory.verifyAuthorityContextEventLog(
    authoritySnapshot({ fromSeq: 1, toSeq: 1, digest }),
    [], { projectId: 'project-a' }
  );
  assert.equal(emptyLog.valid, false);
  assert.equal(emptyLog.range.withinLog, false);
});

test('verifyAuthorityContextEventLog reuses the structural boundaries for context and events', () => {
  const events = threeEventLog();
  const digest = ProjectMemory.computeEventLogRangeDigest(events, 1, 3, {
    projectId: 'project-a'
  });
  assert.throws(() => ProjectMemory.verifyAuthorityContextEventLog(
    authoritySnapshot({ fromSeq: 1, toSeq: 3, digest: 'not-hex' }),
    events, { projectId: 'project-a' }
  ), /64 lowercase hexadecimal/);
  const unbound = authoritySnapshot({ fromSeq: 1, toSeq: 3, digest });
  delete unbound.authorityContextId;
  assert.throws(() => ProjectMemory.verifyAuthorityContextEventLog(unbound, events),
    /authorityContextId is required/);
  assert.throws(() => ProjectMemory.verifyAuthorityContextEventLog(
    authoritySnapshot({ fromSeq: 1, toSeq: 3, digest }),
    events.slice(2), { projectId: 'project-a' }
  ), /seq is discontinuous/);
  assert.throws(() => ProjectMemory.verifyAuthorityContextEventLog(
    authoritySnapshot({ fromSeq: 1, toSeq: 3, digest }),
    events, { projectId: 'project-b' }
  ), /projectId does not match the expected project/);
});

test('verifyAuthorityContextEventLog does not invent winner, activation, or latest semantics', () => {
  const events = threeEventLog();
  // A log longer than the covered range stays verifiable: toSeq is the asserted
  // upper boundary, not "through latest", so the verifier never requires
  // toSeq === eventCount even under coverageIntent 'complete'.
  const store = new ProjectMemory({
    projectId: 'project-a', principalId: 'reader',
    authorizedPrincipals: ['reviewer', 'author'],
    clock: () => new Date('2026-01-02T03:04:05.000Z')
  });
  store.putClaim({
    claimId: 'claim-1', subject: 'service', predicate: 'health', content: { state: 'ok' },
    authorId: 'author', provenance: { source: 'probe', resultSequence: 1 }
  });
  store.approveClaim('claim-1', { actorId: 'reviewer', reason: 'checked' });
  const longerLog = store.audit();
  const digest = ProjectMemory.computeEventLogRangeDigest(longerLog, 1, 2, {
    projectId: 'project-a'
  });
  const result = ProjectMemory.verifyAuthorityContextEventLog({
    ...authoritySnapshot({ fromSeq: 1, toSeq: 2, digest }),
    coverageIntent: 'complete'
  }, longerLog, { projectId: 'project-a' });
  assert.equal(result.valid, true);
  assert.deepEqual(result.range, { fromSeq: 1, toSeq: 2, eventCount: 2, withinLog: true });
  // The result carries only comparison facts: no winner, head, activation,
  // or "latest" assertion.
  assert.deepEqual(Object.keys(result).sort(), ['digest', 'range', 'valid']);
  // Verification is strictly additive to the structural boundaries; an excerpt
  // that is not a complete seq-1 log is still rejected rather than reinterpreted.
  assert.throws(() => ProjectMemory.verifyAuthorityContextEventLog(
    authoritySnapshot({ fromSeq: 2, toSeq: 2, digest }),
    events.slice(1), { projectId: 'project-a' }
  ), /seq is discontinuous/);
});
