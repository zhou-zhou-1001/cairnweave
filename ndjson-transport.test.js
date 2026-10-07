'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough, Writable } = require('node:stream');
const {
  DEFAULT_MAX_FRAME_BYTES,
  TransportError,
  createMessage,
  createEnvelope,
  createNdjsonTransport
} = require('./protocol');

function envelope(id = 'e-1', payload = { ok: true }) {
  return createEnvelope({
    id,
    sender: 'agent:a',
    sentAt: '2026-10-07T00:00:00.000Z',
    message: createMessage({ id: `m-${id}`, kind: 'event', capability: 'test/event', payload })
  });
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('NDJSON transport defaults and injected stream validation are explicit', () => {
  assert.equal(DEFAULT_MAX_FRAME_BYTES, 1024 * 1024);
  assert.throws(() => createNdjsonTransport(), /readable/);
  assert.throws(() => createNdjsonTransport({ readable: new PassThrough(), writable: {} }), /writable/);
  assert.throws(() => createNdjsonTransport({ readable: new PassThrough(), writable: new PassThrough(), maxFrameBytes: 0 }), /positive safe integer/);
});

test('NDJSON transport buffers split chunks, accepts LF and CRLF, and emits multiple frames', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const transport = createNdjsonTransport({ readable: input, writable: output });
  const received = [];
  const errors = [];
  transport.subscribe((value) => received.push(value));
  transport.subscribeErrors((error) => errors.push(error));
  const first = JSON.stringify(envelope('one'));
  const second = JSON.stringify(envelope('two'));
  input.write(Buffer.from(first.slice(0, 17)));
  input.write(Buffer.from(`${first.slice(17)}\r\n${second}\n`));
  await nextTurn();
  assert.deepEqual(received.map(({ id }) => id), ['one', 'two']);
  assert.deepEqual(errors, []);
  await transport.close();
});

test('NDJSON peers exchange envelopes over an injected duplex stream pair', async () => {
  const aToB = new PassThrough();
  const bToA = new PassThrough();
  const a = createNdjsonTransport({ name: 'a', readable: bToA, writable: aToB });
  const b = createNdjsonTransport({ name: 'b', readable: aToB, writable: bToA });
  const atA = [];
  const atB = [];
  a.subscribe((value) => atA.push(value));
  b.subscribe((value) => atB.push(value));
  await Promise.all([a.send(envelope('a-to-b')), b.send(envelope('b-to-a'))]);
  await nextTurn();
  assert.equal(atB[0].id, 'a-to-b');
  assert.equal(atA[0].id, 'b-to-a');
  await Promise.all([a.close(), b.close()]);
});

test('malformed, empty, invalid UTF-8, and invalid envelope frames report stable errors and recover', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const transport = createNdjsonTransport({ readable: input, writable: output });
  const received = [];
  const errors = [];
  transport.subscribe((value) => received.push(value));
  transport.subscribeErrors((error) => errors.push(error));
  input.write('\n{broken}\n{}\n');
  input.write(Buffer.from([0x22, 0xc3, 0x28, 0x22, 0x0a]));
  input.write(`${JSON.stringify(envelope('recovered'))}\n`);
  await nextTurn();
  assert.deepEqual(errors.map(({ code }) => code), [
    'ERR_NDJSON_EMPTY_FRAME',
    'ERR_NDJSON_INVALID_JSON',
    'ERR_NDJSON_INVALID_ENVELOPE',
    'ERR_NDJSON_INVALID_JSON'
  ]);
  assert.ok(errors.every((error) => error instanceof TransportError));
  assert.equal(received[0].id, 'recovered');
  await transport.close();
});

test('oversize inbound frames are reported once, discarded to newline, and parsing resumes', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const transport = createNdjsonTransport({ readable: input, writable: output, maxFrameBytes: 512 });
  const errors = [];
  const received = [];
  transport.subscribeErrors((error) => errors.push(error));
  transport.subscribe((value) => received.push(value));
  input.write('x'.repeat(300));
  input.write(`${'x'.repeat(300)}\n${JSON.stringify(envelope('after'))}\n`);
  await nextTurn();
  assert.deepEqual(errors.map(({ code }) => code), ['ERR_NDJSON_FRAME_TOO_LARGE']);
  assert.equal(received[0].id, 'after');
  await transport.close();
});

test('EOF reports a partial frame, while clean EOF and close are idempotent', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const transport = createNdjsonTransport({ readable: input, writable: output });
  const errors = [];
  transport.subscribeErrors((error) => errors.push(error));
  input.end('{"partial":true}');
  await nextTurn();
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'ERR_NDJSON_TRUNCATED_FRAME');
  assert.equal(errors[0].details.frameBytes, 16);
  await transport.close();
  await transport.close();
});

test('send enforces encoded size, preserves order, and resolves after writable processing', async () => {
  const input = new PassThrough();
  const chunks = [];
  const callbacks = [];
  const output = new Writable({
    write(chunk, encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callbacks.push(callback);
    }
  });
  const transport = createNdjsonTransport({ readable: input, writable: output, maxFrameBytes: 400 });
  let firstDone = false;
  let secondDone = false;
  const first = transport.send(envelope('first')).then(() => { firstDone = true; });
  const second = transport.send(envelope('second')).then(() => { secondDone = true; });
  await nextTurn();
  assert.equal(chunks.length, 1);
  assert.equal(firstDone, false);
  callbacks.shift()();
  await nextTurn();
  assert.equal(firstDone, true);
  assert.equal(chunks.length, 2);
  assert.equal(secondDone, false);
  callbacks.shift()();
  await Promise.all([first, second]);
  assert.deepEqual(chunks.map((chunk) => JSON.parse(chunk.toString()).id), ['first', 'second']);
  await assert.rejects(transport.send(envelope('large', { value: 'x'.repeat(500) })), (error) => error.code === 'ERR_NDJSON_FRAME_TOO_LARGE');
  await transport.close();
  await assert.rejects(transport.send(envelope('closed')), (error) => error.code === 'ERR_TRANSPORT_CLOSED');
});

test('writable failures reject the active send and subsequent sends with stable errors', async () => {
  const input = new PassThrough();
  const output = new Writable({ write(chunk, encoding, callback) { callback(new Error('disk full')); } });
  const transport = createNdjsonTransport({ readable: input, writable: output });
  const errors = [];
  transport.subscribeErrors((error) => errors.push(error));
  await assert.rejects(transport.send(envelope('failure')), (error) => error instanceof TransportError && error.code === 'ERR_TRANSPORT_WRITE');
  await assert.rejects(transport.send(envelope('again')), (error) => error.code === 'ERR_TRANSPORT_WRITE');
  assert.ok(errors.some(({ code }) => code === 'ERR_TRANSPORT_WRITE'));
  await transport.close();
});

test('close does not own injected streams unless endWritableOnClose is requested', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const transport = createNdjsonTransport({ readable: input, writable: output });
  await transport.close();
  assert.equal(output.writableEnded, false);

  const ownedOutput = new PassThrough();
  const owned = createNdjsonTransport({ readable: new PassThrough(), writable: ownedOutput, endWritableOnClose: true });
  await owned.close();
  assert.equal(ownedOutput.writableEnded, true);
});

test('close drains sends accepted before close and rejects sends accepted after it', async () => {
  const callbacks = [];
  const output = new Writable({ write(chunk, encoding, callback) { callbacks.push(callback); } });
  const transport = createNdjsonTransport({ readable: new PassThrough(), writable: output });
  const first = transport.send(envelope('before-close-1'));
  const second = transport.send(envelope('before-close-2'));
  const closing = transport.close();
  await assert.rejects(transport.send(envelope('after-close')), (error) => error.code === 'ERR_TRANSPORT_CLOSED');
  await nextTurn();
  callbacks.shift()();
  await nextTurn();
  callbacks.shift()();
  await Promise.all([first, second, closing]);
});
