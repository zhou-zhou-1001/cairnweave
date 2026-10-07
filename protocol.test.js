'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const protocol = require('./protocol');
const { MESSAGE_SCHEMA, ENVELOPE_SCHEMA, CAPABILITY_SCHEMA, ProtocolError, cloneWireValue, isWireValue, createMessage, normalizeMessage, assertReplyCorrelation, createEnvelope, normalizeEnvelope, createCapability, normalizeCapabilities, negotiateCapabilities, createTransport, assertTransport } = protocol;

test('protocol is additive without changing the legacy enumerable root API', () => {
  assert.strictEqual(require('.').protocol, protocol);
  assert.strictEqual(require('cairnweave/protocol'), protocol);
  assert.equal(Object.keys(require('.')).includes('protocol'), false);
});

test('wire values round-trip as independent JSON-safe data', () => {
  const source = { text: 'ok', count: 2, flags: [true, null], nested: Object.assign(Object.create(null), { value: 'x' }) };
  const copy = cloneWireValue(source);
  source.flags[0] = false;
  copy.nested.value = 'changed';
  assert.deepEqual(copy, { text: 'ok', count: 2, flags: [true, null], nested: { value: 'changed' } });
  assert.equal(isWireValue(source), true);
});

test('wire boundary rejects values JSON would lose or reinterpret', () => {
  const circular = {}; circular.self = circular;
  const sparse = []; sparse[1] = 'x';
  const hidden = {};
  Object.defineProperty(hidden, 'value', { value: 'lost' });
  const symbolArray = [];
  symbolArray[Symbol('lost')] = true;
  for (const value of [undefined, 1n, NaN, Infinity, -0, new Date(), circular, sparse, hidden, symbolArray, { fn() {} }]) {
    assert.equal(isWireValue(value), false);
    assert.throws(() => cloneWireValue(value), TypeError);
  }
  const accessor = {};
  Object.defineProperty(accessor, 'value', { enumerable: true, get: () => 'hidden execution' });
  assert.throws(() => cloneWireValue(accessor), /data property/);
});

test('message factory creates versioned requests and correlated responses', () => {
  const request = createMessage({ id: 'm-1', kind: 'request', capability: 'tools/read', payload: { path: 'a' }, trace: { id: 't-1' } });
  const response = createMessage({ id: 'm-2', kind: 'response', capability: 'tools/read', correlationId: request.id, payload: { text: 'done' } });
  assert.equal(request.schema, MESSAGE_SCHEMA);
  assert.equal(response.correlationId, 'm-1');
  assert.deepEqual(normalizeMessage(JSON.parse(JSON.stringify(request))), request);
  request.payload.path = 'changed';
  assert.equal(response.payload.text, 'done');
});

test('message boundary rejects unsupported versions, kinds, missing payload, and uncorrelated outcomes', () => {
  assert.throws(() => createMessage({ kind: 'command', capability: 'x', payload: null }), /kind/);
  assert.throws(() => normalizeMessage({ schema: MESSAGE_SCHEMA, version: 1, id: 'x', kind: 'event', capability: 'x' }), /payload/);
  assert.throws(() => createMessage({ kind: 'error', capability: 'x', payload: { code: 'failed' } }), /correlationId/);
  assert.throws(() => normalizeMessage({ schema: MESSAGE_SCHEMA, version: 2, id: 'x', kind: 'event', capability: 'x', payload: null }), /version/);
});

test('reply correlation validates request identity and capability with stable errors', () => {
  const request = createMessage({ id: 'request-1', kind: 'request', capability: 'files/read', payload: {} });
  const response = createMessage({ kind: 'response', capability: 'files/read', correlationId: 'request-1', payload: {} });
  assert.deepEqual(assertReplyCorrelation(request, response), response);
  assert.throws(
    () => assertReplyCorrelation(request, { ...response, correlationId: 'other' }),
    (error) => error instanceof ProtocolError && error.code === 'ERR_PROTOCOL_CORRELATION_MISMATCH'
  );
  assert.throws(
    () => assertReplyCorrelation(request, { ...response, capability: 'files/write' }),
    (error) => error.code === 'ERR_PROTOCOL_CAPABILITY_MISMATCH'
  );
  assert.throws(
    () => assertReplyCorrelation(response, response),
    (error) => error.code === 'ERR_PROTOCOL_NOT_REQUEST'
  );
});

test('envelope keeps routing separate from message semantics and preserves extensions', () => {
  const inputMessage = createMessage({ id: 'm-1', kind: 'event', capability: 'status', payload: { ready: true } });
  const envelope = createEnvelope({ id: 'e-1', sender: 'agent:a', recipient: 'agent:b', sentAt: '2026-01-02T03:04:05.000Z', message: inputMessage, hop: 1 });
  inputMessage.payload.ready = false;
  assert.equal(envelope.schema, ENVELOPE_SCHEMA);
  assert.equal(envelope.message.payload.ready, true);
  assert.equal(envelope.hop, 1);
  assert.deepEqual(normalizeEnvelope(JSON.parse(JSON.stringify(envelope))), envelope);
});

test('envelope rejects invalid routing, timestamps, and nested messages', () => {
  const message = createMessage({ kind: 'event', capability: 'status', payload: null });
  assert.throws(() => createEnvelope({ sender: '', message }), /sender/);
  assert.throws(() => createEnvelope({ sender: 'a', sentAt: 'not-time', message }), /sentAt/);
  assert.throws(() => createEnvelope({ sender: 'a', message: { ...message, version: 9 } }), /message.version/);
});

test('capabilities are versioned descriptors and negotiate exact revisions', () => {
  const read1 = createCapability({ name: 'tools/read', revision: 1, description: 'Read data', limits: { bytes: 10 } });
  const read2 = createCapability({ name: 'tools/read', revision: 2 });
  const write1 = createCapability({ name: 'tools/write', revision: 1 });
  assert.equal(read1.schema, CAPABILITY_SCHEMA);
  assert.deepEqual(negotiateCapabilities([read2, read1, write1], [read1]), [read1]);
  assert.throws(() => normalizeCapabilities([read1, read1]), /duplicates/);
  assert.throws(() => createCapability({ name: 'x', revision: 0 }), /positive/);
});

test('transport adapter validates outbound and inbound envelopes', async () => {
  const sent = []; let receiver; let closed = false;
  const transport = createTransport({
    name: 'memory-test',
    send: async (envelope) => { sent.push(envelope); return { accepted: true }; },
    subscribe: (handler) => { receiver = handler; return () => { receiver = undefined; }; },
    close: () => { closed = true; }
  });
  assert.strictEqual(assertTransport(transport), transport);
  const received = [];
  const unsubscribe = transport.subscribe((envelope) => received.push(envelope));
  const envelope = createEnvelope({ sender: 'a', message: createMessage({ kind: 'event', capability: 'status', payload: true }) });
  assert.deepEqual(await transport.send(envelope), { accepted: true });
  receiver(envelope);
  assert.equal(sent.length, 1);
  assert.equal(received.length, 1);
  assert.throws(() => receiver({}), /envelope.schema/);
  unsubscribe();
  await transport.close();
  assert.equal(closed, true);
});

test('transport contract rejects incomplete adapters and invalid unsubscribe behavior', () => {
  assert.throws(() => assertTransport({ name: 'x', send() {}, subscribe() {} }), /transport must implement/);
  const transport = createTransport({ name: 'bad', send() {}, subscribe() {} });
  assert.throws(() => transport.subscribe(() => {}), /unsubscribe/);
  assert.equal(typeof transport.subscribeErrors(() => {}), 'function');
  assert.throws(() => createTransport({ name: 'bad-errors', send() {}, subscribe() { return () => {}; }, subscribeErrors: true }), /subscribeErrors/);
});
