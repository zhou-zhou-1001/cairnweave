'use strict';

const { randomUUID } = require('node:crypto');
const { cloneWireValue } = require('./wire');
const { ProtocolError } = require('./errors');

const MESSAGE_SCHEMA = 'cairnweave/protocol-message';
const MESSAGE_VERSION = 1;
const MESSAGE_KINDS = Object.freeze(['request', 'response', 'event', 'error']);
const KIND_SET = new Set(MESSAGE_KINDS);

function nonEmpty(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} must be a non-empty string`);
}

function normalizeMessage(input) {
  const message = cloneWireValue(input, 'message');
  if (!message || Array.isArray(message)) throw new TypeError('message must be an object');
  if (message.schema !== MESSAGE_SCHEMA) throw new Error('message.schema is unsupported');
  if (message.version !== MESSAGE_VERSION) throw new Error('message.version is unsupported');
  nonEmpty(message.id, 'message.id');
  if (!KIND_SET.has(message.kind)) throw new TypeError(`message.kind must be one of: ${MESSAGE_KINDS.join(', ')}`);
  nonEmpty(message.capability, 'message.capability');
  if (!Object.hasOwn(message, 'payload')) throw new TypeError('message.payload is required');
  if (Object.hasOwn(message, 'correlationId')) nonEmpty(message.correlationId, 'message.correlationId');
  if (Object.hasOwn(message, 'replyTo')) nonEmpty(message.replyTo, 'message.replyTo');
  if (message.kind === 'response' || message.kind === 'error') {
    if (!Object.hasOwn(message, 'correlationId')) throw new TypeError(`message.correlationId is required for ${message.kind}`);
  }
  return message;
}

function createMessage({ id = randomUUID(), kind, capability, payload, correlationId, replyTo, ...extensions } = {}) {
  const message = {
    schema: MESSAGE_SCHEMA,
    version: MESSAGE_VERSION,
    id,
    kind,
    capability,
    payload,
    ...extensions
  };
  if (correlationId !== undefined) message.correlationId = correlationId;
  if (replyTo !== undefined) message.replyTo = replyTo;
  return normalizeMessage(message);
}

function assertReplyCorrelation(requestInput, replyInput) {
  const request = normalizeMessage(requestInput);
  const reply = normalizeMessage(replyInput);
  if (request.kind !== 'request') {
    throw new ProtocolError('ERR_PROTOCOL_NOT_REQUEST', 'correlation source must be a request message');
  }
  if (reply.kind !== 'response' && reply.kind !== 'error') {
    throw new ProtocolError('ERR_PROTOCOL_NOT_REPLY', 'correlated message must be a response or error');
  }
  if (reply.correlationId !== request.id) {
    throw new ProtocolError('ERR_PROTOCOL_CORRELATION_MISMATCH', 'reply.correlationId does not match request.id');
  }
  if (reply.capability !== request.capability) {
    throw new ProtocolError('ERR_PROTOCOL_CAPABILITY_MISMATCH', 'reply.capability does not match request.capability');
  }
  return reply;
}

module.exports = { MESSAGE_SCHEMA, MESSAGE_VERSION, MESSAGE_KINDS, createMessage, normalizeMessage, assertReplyCorrelation };
