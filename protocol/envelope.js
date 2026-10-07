'use strict';

const { randomUUID } = require('node:crypto');
const { cloneWireValue } = require('./wire');
const { normalizeMessage } = require('./message');

const ENVELOPE_SCHEMA = 'cairnweave/protocol-envelope';
const ENVELOPE_VERSION = 1;

function nonEmpty(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} must be a non-empty string`);
}

function normalizeEnvelope(input) {
  const envelope = cloneWireValue(input, 'envelope');
  if (!envelope || Array.isArray(envelope)) throw new TypeError('envelope must be an object');
  if (envelope.schema !== ENVELOPE_SCHEMA) throw new Error('envelope.schema is unsupported');
  if (envelope.version !== ENVELOPE_VERSION) throw new Error('envelope.version is unsupported');
  nonEmpty(envelope.id, 'envelope.id');
  nonEmpty(envelope.sender, 'envelope.sender');
  if (Object.hasOwn(envelope, 'recipient')) nonEmpty(envelope.recipient, 'envelope.recipient');
  if (typeof envelope.sentAt !== 'string' || Number.isNaN(Date.parse(envelope.sentAt))) {
    throw new TypeError('envelope.sentAt must be a valid timestamp string');
  }
  envelope.message = normalizeMessage(envelope.message);
  return envelope;
}

function createEnvelope({ id = randomUUID(), sender, recipient, sentAt = new Date().toISOString(), message, ...extensions } = {}) {
  const envelope = {
    schema: ENVELOPE_SCHEMA,
    version: ENVELOPE_VERSION,
    id,
    sender,
    sentAt,
    message,
    ...extensions
  };
  if (recipient !== undefined) envelope.recipient = recipient;
  return normalizeEnvelope(envelope);
}

module.exports = { ENVELOPE_SCHEMA, ENVELOPE_VERSION, createEnvelope, normalizeEnvelope };
