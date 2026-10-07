'use strict';

const { createTransport } = require('./transport');
const { normalizeEnvelope } = require('./envelope');
const { TransportError } = require('./errors');
const { TextDecoder } = require('node:util');

const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;

function transportError(code, message, details, cause) {
  return new TransportError(code, message, { details, cause });
}

function createNdjsonTransport({
  readable,
  writable,
  name = 'ndjson',
  maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
  endWritableOnClose = false
} = {}) {
  if (!readable || typeof readable.on !== 'function' || typeof readable.removeListener !== 'function') {
    throw new TypeError('readable must be an injected Node.js readable stream');
  }
  if (!writable || typeof writable.write !== 'function' || typeof writable.on !== 'function' || typeof writable.removeListener !== 'function') {
    throw new TypeError('writable must be an injected Node.js writable stream');
  }
  if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1) {
    throw new TypeError('maxFrameBytes must be a positive safe integer');
  }
  if (typeof endWritableOnClose !== 'boolean') throw new TypeError('endWritableOnClose must be a boolean');

  const subscribers = new Set();
  const errorSubscribers = new Set();
  let buffer = Buffer.alloc(0);
  let discardingOversize = false;
  let closed = false;
  let readableEnded = false;
  let writableFailure;
  let sendTail = Promise.resolve();
  const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

  function report(error) {
    for (const handler of [...errorSubscribers]) {
      try { handler(error); } catch { /* An error observer cannot break stream processing. */ }
    }
  }

  function decodeFrame(frame) {
    if (frame.length > 0 && frame[frame.length - 1] === 0x0d) frame = frame.subarray(0, frame.length - 1);
    if (frame.length === 0) {
      report(transportError('ERR_NDJSON_EMPTY_FRAME', 'NDJSON frame must not be empty'));
      return;
    }
    let value;
    try {
      value = JSON.parse(utf8Decoder.decode(frame));
    } catch (cause) {
      report(transportError('ERR_NDJSON_INVALID_JSON', 'NDJSON frame contains invalid JSON', { frameBytes: frame.length }, cause));
      return;
    }
    let envelope;
    try {
      envelope = normalizeEnvelope(value);
    } catch (cause) {
      report(transportError('ERR_NDJSON_INVALID_ENVELOPE', `NDJSON frame contains an invalid envelope: ${cause.message}`, { frameBytes: frame.length }, cause));
      return;
    }
    for (const handler of [...subscribers]) {
      try { handler(envelope); } catch (cause) {
        report(transportError('ERR_TRANSPORT_HANDLER', 'transport subscriber threw while handling an envelope', undefined, cause));
      }
    }
  }

  function onData(chunk) {
    if (closed) return;
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    while (offset < incoming.length) {
      if (discardingOversize) {
        const newline = incoming.indexOf(0x0a, offset);
        if (newline === -1) return;
        discardingOversize = false;
        offset = newline + 1;
        continue;
      }

      const newline = incoming.indexOf(0x0a, offset);
      if (newline === -1) {
        const remainder = incoming.subarray(offset);
        if (buffer.length + remainder.length > maxFrameBytes) {
          buffer = Buffer.alloc(0);
          discardingOversize = true;
          report(transportError('ERR_NDJSON_FRAME_TOO_LARGE', `NDJSON frame exceeds maxFrameBytes (${maxFrameBytes})`, { maxFrameBytes }));
        } else {
          buffer = buffer.length === 0 ? Buffer.from(remainder) : Buffer.concat([buffer, remainder]);
        }
        return;
      }

      const segment = incoming.subarray(offset, newline);
      const frameLength = buffer.length + segment.length;
      if (frameLength > maxFrameBytes) {
        report(transportError('ERR_NDJSON_FRAME_TOO_LARGE', `NDJSON frame exceeds maxFrameBytes (${maxFrameBytes})`, { maxFrameBytes, frameBytes: frameLength }));
        buffer = Buffer.alloc(0);
      } else {
        const frame = buffer.length === 0 ? segment : Buffer.concat([buffer, segment]);
        buffer = Buffer.alloc(0);
        decodeFrame(frame);
      }
      offset = newline + 1;
    }
  }

  function onEnd() {
    if (readableEnded) return;
    readableEnded = true;
    if (discardingOversize) {
      discardingOversize = false;
      return;
    }
    if (buffer.length > 0) {
      const frameBytes = buffer.length;
      buffer = Buffer.alloc(0);
      report(transportError('ERR_NDJSON_TRUNCATED_FRAME', 'readable ended before the NDJSON frame delimiter', { frameBytes }));
    }
  }

  function onReadableError(cause) {
    report(transportError('ERR_TRANSPORT_READ', 'readable stream failed', undefined, cause));
  }

  function onWritableError(cause) {
    writableFailure = transportError('ERR_TRANSPORT_WRITE', 'writable stream failed', undefined, cause);
    report(writableFailure);
  }

  readable.on('data', onData);
  readable.on('end', onEnd);
  readable.on('close', onEnd);
  readable.on('error', onReadableError);
  writable.on('error', onWritableError);

  function writeFrame(envelope) {
    if (writableFailure) throw writableFailure;
    if (writable.destroyed || writable.writableEnded) throw transportError('ERR_TRANSPORT_WRITE', 'writable stream is not open');
    const frame = Buffer.from(`${JSON.stringify(envelope)}\n`, 'utf8');
    if (frame.length - 1 > maxFrameBytes) {
      throw transportError('ERR_NDJSON_FRAME_TOO_LARGE', `encoded envelope exceeds maxFrameBytes (${maxFrameBytes})`, { maxFrameBytes, frameBytes: frame.length - 1 });
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        writable.removeListener('error', fail);
        if (error) {
          writableFailure = transportError('ERR_TRANSPORT_WRITE', 'writable stream failed', undefined, error);
          reject(writableFailure);
        } else resolve();
      };
      const fail = (error) => finish(error);
      writable.once('error', fail);
      try { writable.write(frame, finish); } catch (error) { finish(error); }
    });
  }

  const transport = createTransport({
    name,
    send(envelope) {
      if (closed) return Promise.reject(transportError('ERR_TRANSPORT_CLOSED', 'transport is closed'));
      const operation = sendTail.then(() => writeFrame(envelope));
      sendTail = operation.catch(() => {});
      return operation;
    },
    subscribe(handler) {
      subscribers.add(handler);
      return () => subscribers.delete(handler);
    },
    subscribeErrors(handler) {
      errorSubscribers.add(handler);
      return () => errorSubscribers.delete(handler);
    },
    async close() {
      if (closed) return;
      closed = true;
      readable.removeListener('data', onData);
      readable.removeListener('end', onEnd);
      readable.removeListener('close', onEnd);
      readable.removeListener('error', onReadableError);
      writable.removeListener('error', onWritableError);
      subscribers.clear();
      errorSubscribers.clear();
      await sendTail;
      if (endWritableOnClose && typeof writable.end === 'function' && !writable.writableEnded) {
        await new Promise((resolve, reject) => {
          let settled = false;
          const finish = (error) => {
            if (settled) return;
            settled = true;
            writable.removeListener('error', fail);
            if (error) reject(transportError('ERR_TRANSPORT_WRITE', 'writable stream failed while closing', undefined, error));
            else resolve();
          };
          const fail = (error) => finish(error);
          writable.once('error', fail);
          try { writable.end(() => finish()); } catch (error) { finish(error); }
        });
      }
    }
  });
  return transport;
}

module.exports = { DEFAULT_MAX_FRAME_BYTES, createNdjsonTransport };
