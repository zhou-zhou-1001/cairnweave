'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

const STORE_VERSION = 1;
const STORE_SCHEMA = 'agent-integrity-guard/artifact-envelope';

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

function digest(artifact) {
  return createHash('sha256').update(canonical(artifact)).digest('hex');
}

function makeEnvelope(artifact) {
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) throw new TypeError('artifact must be an object');
  return { version: STORE_VERSION, schema: STORE_SCHEMA, artifact: structuredClone(artifact), integrity: { algorithm: 'sha256', digest: digest(artifact) } };
}

function validateEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object' || envelope.version !== STORE_VERSION || envelope.schema !== STORE_SCHEMA) throw new Error(`unsupported artifact envelope (expected version ${STORE_VERSION})`);
  if (!envelope.artifact || typeof envelope.artifact !== 'object' || Array.isArray(envelope.artifact)) throw new TypeError('artifact envelope payload is invalid');
  if (!envelope.integrity || envelope.integrity.algorithm !== 'sha256' || typeof envelope.integrity.digest !== 'string') throw new TypeError('artifact envelope integrity is invalid');
  if (digest(envelope.artifact) !== envelope.integrity.digest) throw new Error('artifact integrity mismatch');
  return structuredClone(envelope.artifact);
}

async function saveArtifact(filePath, artifact) {
  if (typeof filePath !== 'string' || filePath.trim() === '') throw new TypeError('filePath must be non-empty');
  const destination = path.resolve(filePath);
  const envelope = makeEnvelope(artifact);
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  try {
    await fsp.writeFile(temporary, `${JSON.stringify(envelope, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fsp.rename(temporary, destination);
    return structuredClone(envelope);
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function loadArtifact(filePath) {
  if (typeof filePath !== 'string' || filePath.trim() === '') throw new TypeError('filePath must be non-empty');
  let envelope;
  try { envelope = JSON.parse(await fsp.readFile(path.resolve(filePath), 'utf8')); } catch (error) {
    if (error instanceof SyntaxError) throw new Error('artifact envelope is not valid JSON');
    throw error;
  }
  return validateEnvelope(envelope);
}

module.exports = { STORE_VERSION, STORE_SCHEMA, canonical, digest, makeEnvelope, validateEnvelope, saveArtifact, loadArtifact };
