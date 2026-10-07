'use strict';

const { normalizeEnvelope } = require('./envelope');

function createTransport({ name, send, subscribe, subscribeErrors, close } = {}) {
  if (typeof name !== 'string' || name.trim() === '') throw new TypeError('transport.name must be a non-empty string');
  if (typeof send !== 'function') throw new TypeError('transport.send must be a function');
  if (typeof subscribe !== 'function') throw new TypeError('transport.subscribe must be a function');
  if (subscribeErrors !== undefined && typeof subscribeErrors !== 'function') throw new TypeError('transport.subscribeErrors must be a function');
  if (close !== undefined && typeof close !== 'function') throw new TypeError('transport.close must be a function');

  const transport = {
    name,
    send(envelope) {
      return Promise.resolve(send(normalizeEnvelope(envelope)));
    },
    subscribe(handler) {
      if (typeof handler !== 'function') throw new TypeError('handler must be a function');
      const unsubscribe = subscribe((envelope) => handler(normalizeEnvelope(envelope)));
      if (typeof unsubscribe !== 'function') throw new TypeError('transport.subscribe must return an unsubscribe function');
      return unsubscribe;
    },
    subscribeErrors(handler) {
      if (typeof handler !== 'function') throw new TypeError('handler must be a function');
      if (subscribeErrors === undefined) return () => {};
      const unsubscribe = subscribeErrors(handler);
      if (typeof unsubscribe !== 'function') throw new TypeError('transport.subscribeErrors must return an unsubscribe function');
      return unsubscribe;
    },
    close() {
      return Promise.resolve(close === undefined ? undefined : close());
    }
  };
  return Object.freeze(transport);
}

function assertTransport(value) {
  if (!value || typeof value !== 'object' || typeof value.name !== 'string' || value.name.trim() === '' ||
      typeof value.send !== 'function' || typeof value.subscribe !== 'function' || typeof value.close !== 'function') {
    throw new TypeError('transport must implement name, send(), subscribe(), and close()');
  }
  if (value.subscribeErrors !== undefined && typeof value.subscribeErrors !== 'function') {
    throw new TypeError('transport.subscribeErrors must be a function when present');
  }
  return value;
}

module.exports = { createTransport, assertTransport };
