'use strict';

const { cloneWireValue } = require('./wire');

const CAPABILITY_SCHEMA = 'cairnweave/protocol-capability';
const CAPABILITY_VERSION = 1;

function normalizeCapability(input) {
  const capability = cloneWireValue(input, 'capability');
  if (!capability || Array.isArray(capability)) throw new TypeError('capability must be an object');
  if (capability.schema !== CAPABILITY_SCHEMA) throw new Error('capability.schema is unsupported');
  if (capability.version !== CAPABILITY_VERSION) throw new Error('capability.version is unsupported');
  if (typeof capability.name !== 'string' || capability.name.trim() === '') throw new TypeError('capability.name must be a non-empty string');
  if (!Number.isSafeInteger(capability.revision) || capability.revision < 1) throw new TypeError('capability.revision must be a positive safe integer');
  if (Object.hasOwn(capability, 'description') && typeof capability.description !== 'string') throw new TypeError('capability.description must be a string');
  return capability;
}

function createCapability({ name, revision = 1, description, ...extensions } = {}) {
  const capability = { schema: CAPABILITY_SCHEMA, version: CAPABILITY_VERSION, name, revision, ...extensions };
  if (description !== undefined) capability.description = description;
  return normalizeCapability(capability);
}

function normalizeCapabilities(input) {
  if (!Array.isArray(input)) throw new TypeError('capabilities must be an array');
  const seen = new Set();
  return input.map((entry, index) => {
    const capability = normalizeCapability(entry);
    const key = `${capability.name}\u0000${capability.revision}`;
    if (seen.has(key)) throw new Error(`capabilities[${index}] duplicates a name and revision`);
    seen.add(key);
    return capability;
  });
}

function negotiateCapabilities(local, remote) {
  const localCapabilities = normalizeCapabilities(local);
  const remoteKeys = new Set(normalizeCapabilities(remote).map(({ name, revision }) => `${name}\u0000${revision}`));
  return localCapabilities.filter(({ name, revision }) => remoteKeys.has(`${name}\u0000${revision}`));
}

module.exports = { CAPABILITY_SCHEMA, CAPABILITY_VERSION, createCapability, normalizeCapability, normalizeCapabilities, negotiateCapabilities };
