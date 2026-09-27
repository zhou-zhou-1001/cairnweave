'use strict';

const { createHash } = require('node:crypto');

const STATUSES = new Set(['candidate', 'approved', 'disputed', 'superseded']);
const VISIBILITIES = new Set(['project', 'private']);
const ACTIONS = new Set(['put', 'approve', 'dispute', 'supersede']);
const EVENT_SCHEMA = 'cairnweave/project-memory-event';
const EVENT_VERSION = 1;
const EVENT_LOG_CANONICALIZATION_SCHEMA = 'cairnweave/project-memory-event-log';
const EVENT_LOG_CANONICALIZATION_VERSION = 1;
const AUTHORITY_CONTEXT_SCHEMA = 'cairnweave/project-memory-authority-context';
const AUTHORITY_CONTEXT_VERSION = 1;
const COVERAGE_INTENTS = new Set(['complete', 'partial']);

function requireNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function copy(value) {
  return structuredClone(value);
}

function validateStringList(value, name) {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  value.forEach((entry, index) => requireNonEmptyString(entry, `${name}[${index}]`));
}

function validateUniqueStringList(value, name) {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  const seen = new Set();
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) throw new TypeError(`${name}[${index}] is required`);
    const entry = value[index];
    requireNonEmptyString(entry, `${name}[${index}]`);
    if (seen.has(entry)) throw new Error(`${name}[${index}] duplicates a principal`);
    seen.add(entry);
  }
}

function validateTimestamp(value, name) {
  if (value === undefined) return;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new TypeError(`${name} must be a valid timestamp string`);
  }
}

function requirePositiveSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
}

function requireRecord(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
}

function requireEnumerableDataProperty(value, key, name) {
  if (!Object.hasOwn(value, key)) throw new TypeError(`${name} is required`);
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
    throw new TypeError(`${name} must be an enumerable data property`);
  }
  return descriptor.value;
}

function validatePutEvent(event, name) {
  const claim = requireEnumerableDataProperty(event, 'claim', `${name}.claim`);
  requireRecord(claim, `${name}.claim`);
  for (const key of [
    'projectId', 'claimId', 'authorId', 'subject', 'predicate', 'scope',
    'content', 'visibility', 'status', 'provenance', 'sensitivity',
    'allowedPrincipals'
  ]) {
    requireEnumerableDataProperty(claim, key, `${name}.claim.${key}`);
  }
  if (claim.projectId !== event.projectId || claim.claimId !== event.claimId ||
      claim.authorId !== event.actorId) {
    throw new Error(`${name}.claim identity does not match the event envelope`);
  }
  requireNonEmptyString(claim.subject, `${name}.claim.subject`);
  requireNonEmptyString(claim.predicate, `${name}.claim.predicate`);
  requireNonEmptyString(claim.authorId, `${name}.claim.authorId`);
  requireNonEmptyString(claim.scope, `${name}.claim.scope`);
  if (claim.scope !== 'project') throw new Error(`${name}.claim.scope is unsupported`);
  if (claim.content === undefined) throw new TypeError(`${name}.claim.content is required`);
  if (!VISIBILITIES.has(claim.visibility)) throw new TypeError(`${name}.claim.visibility is invalid`);
  if (claim.status !== 'candidate') throw new Error(`${name}.claim must start as candidate`);
  if (!Object.hasOwn(claim, 'provenance') || claim.provenance === undefined || claim.provenance === null) {
    throw new TypeError(`${name}.claim.provenance is required`);
  }
  requireNonEmptyString(claim.sensitivity, `${name}.claim.sensitivity`);
  validateStringList(claim.allowedPrincipals, `${name}.claim.allowedPrincipals`);
  validateTimestamp(claim.observedAt, `${name}.claim.observedAt`);
  validateTimestamp(claim.expiresAt, `${name}.claim.expiresAt`);
}

function validateEventLog(events, { projectId } = {}) {
  if (!Array.isArray(events)) throw new TypeError('events must be an array');
  if (projectId !== undefined) requireNonEmptyString(projectId, 'projectId');

  // Validate the caller-owned shape before structuredClone(), which otherwise
  // drops non-enumerable/accessor properties and can hide malformed input.
  for (let index = 0; index < events.length; index += 1) {
    const name = `events[${index}]`;
    if (!Object.hasOwn(events, index)) throw new TypeError(`${name} is required`);
    const event = events[index];
    requireRecord(event, name);
    for (const key of [
      'eventSchema', 'eventVersion', 'seq', 'revision', 'timestamp', 'actorId',
      'projectId', 'claimId', 'action'
    ]) {
      requireEnumerableDataProperty(event, key, `${name}.${key}`);
    }
    if (event.action === 'put') validatePutEvent(event, name);
  }

  const normalized = copy(events);
  const states = new Map();
  let logProjectId = projectId;

  normalized.forEach((event, index) => {
    const name = `events[${index}]`;
    requireRecord(event, name);
    for (const key of [
      'eventSchema', 'eventVersion', 'seq', 'revision', 'timestamp', 'actorId',
      'projectId', 'claimId', 'action'
    ]) {
      requireEnumerableDataProperty(event, key, `${name}.${key}`);
    }
    if (event.eventSchema !== EVENT_SCHEMA) {
      throw new Error(`${name}.eventSchema is unsupported`);
    }
    if (event.eventVersion !== EVENT_VERSION) {
      throw new Error(`${name}.eventVersion is unsupported`);
    }
    requirePositiveSafeInteger(event.seq, `${name}.seq`);
    if (event.seq !== index + 1) throw new Error(`${name}.seq is discontinuous`);
    requirePositiveSafeInteger(event.revision, `${name}.revision`);
    validateTimestamp(event.timestamp, `${name}.timestamp`);
    if (event.timestamp === undefined) throw new TypeError(`${name}.timestamp is required`);
    requireNonEmptyString(event.actorId, `${name}.actorId`);
    requireNonEmptyString(event.projectId, `${name}.projectId`);
    requireNonEmptyString(event.claimId, `${name}.claimId`);
    requireNonEmptyString(event.action, `${name}.action`);
    if (!ACTIONS.has(event.action)) throw new Error(`${name}.action is unsupported`);

    if (logProjectId === undefined) logProjectId = event.projectId;
    if (event.projectId !== logProjectId) throw new Error(`${name}.projectId does not match the event log`);

    const prior = states.get(event.claimId);
    const expectedRevision = prior === undefined ? 1 : prior.revision + 1;
    if (event.revision !== expectedRevision) throw new Error(`${name}.revision is discontinuous`);

    if (event.action === 'put') {
      if (prior !== undefined) throw new Error(`${name}.action duplicates a claim creation`);
      validatePutEvent(event, name);
      states.set(event.claimId, {
        revision: event.revision, status: 'candidate',
        subject: event.claim.subject, predicate: event.claim.predicate
      });
      return;
    }

    if (prior === undefined) throw new Error(`${name}.action precedes claim creation`);
    if (event.fromStatus !== prior.status) throw new Error(`${name}.fromStatus does not match prior state`);
    requireNonEmptyString(event.reason, `${name}.reason`);

    if (event.action === 'approve') {
      if (prior.status !== 'candidate' || event.toStatus !== 'approved') {
        throw new Error(`${name} has an invalid approval transition`);
      }
    } else if (event.action === 'dispute') {
      if (!['candidate', 'approved'].includes(prior.status) || event.toStatus !== 'disputed') {
        throw new Error(`${name} has an invalid dispute transition`);
      }
    } else {
      if (prior.status === 'superseded' || event.toStatus !== 'superseded') {
        throw new Error(`${name} has an invalid supersession transition`);
      }
      requireNonEmptyString(event.replacementClaimId, `${name}.replacementClaimId`);
      const replacement = states.get(event.replacementClaimId);
      if (event.replacementClaimId === event.claimId || replacement?.status !== 'approved' ||
          event.replacementStatus !== 'approved') {
        throw new Error(`${name} has an invalid supersession replacement`);
      }
      if (replacement.subject !== prior.subject || replacement.predicate !== prior.predicate) {
        throw new Error(`${name} has an unrelated supersession replacement`);
      }
    }
    states.set(event.claimId, {
      revision: event.revision, status: event.toStatus,
      subject: prior.subject, predicate: prior.predicate
    });
  });

  return normalized;
}

const EVENT_ENVELOPE_FIELDS = [
  'eventSchema', 'eventVersion', 'seq', 'revision', 'timestamp', 'actorId',
  'projectId', 'claimId', 'action'
];
const CLAIM_SNAPSHOT_FIELDS = [
  'projectId', 'claimId', 'authorId', 'subject', 'predicate', 'scope',
  'content', 'visibility', 'status', 'provenance', 'sensitivity',
  'allowedPrincipals'
];

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPositiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 1;
}

function isValidTimestamp(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function inspectEnumerableDataProperty(value, key) {
  if (!Object.hasOwn(value, key)) return { ok: false, reason: 'missing' };
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
    return { ok: false, reason: 'invalid' };
  }
  return { ok: true, value: descriptor.value };
}

function readProperty(value, key) {
  try {
    return { ok: true, value: value[key] };
  } catch {
    return { ok: false };
  }
}

function diagnosticError(code, message, path, index, seq) {
  const error = { code, message, path };
  if (index !== undefined) error.index = index;
  if (seq !== undefined) error.seq = seq;
  return error;
}

/**
 * Non-throwing, error-collecting companion to validateEventLog(). Returns
 * { valid, errors } where each error is { code, message, path, index?, seq? }.
 *
 * Mirrors validateEventLog()'s validation boundary and shared failure messages,
 * but collects every independent defect it can evaluate instead of stopping at
 * the first. Hostile inputs that cannot be inspected safely are reported with
 * sanitized diagnostics rather than leaking values through thrown errors.
 * For an otherwise fully valid log it also confirms the log can be defensively
 * cloned, so the valid/throws verdict agrees with validateEventLog() on every
 * input; the clone itself is never returned. Messages and paths reference only
 * field names — never claim identifiers or claim content. The diagnostic state
 * machine advances only past fully valid events, so later events are evaluated
 * against the last fully valid state. Diagnostics are structural completeness
 * checks only: no winner/latest/activation/replay/import/persistence/auth/
 * signature semantics, and the result is not an authorization decision.
 */
function diagnoseEventLog(events, options) {
  const errors = [];
  const record = (code, message, path, index, seq) => {
    errors.push(diagnosticError(code, message, path, index, seq));
  };

  let projectId;
  try {
    projectId = options === null || typeof options !== 'object'
      ? undefined
      : options.projectId;
  } catch {
    record('EVENT_INSPECTION_FAILED', 'options could not be inspected safely', 'options');
    projectId = undefined;
  }

  if (!Array.isArray(events)) {
    record('EVENT_LOG_NOT_ARRAY', 'events must be an array', 'events');
    return { valid: false, errors };
  }
  if (projectId !== undefined && !isNonEmptyString(projectId)) {
    record('PROJECT_ID_OPTION_INVALID', 'projectId must be a non-empty string', 'projectId');
  }

  let length;
  try {
    length = events.length;
  } catch {
    record('EVENT_INSPECTION_FAILED', 'events could not be inspected safely', 'events');
    return { valid: false, errors };
  }

  const states = new Map();
  let logProjectId = projectId !== undefined && isNonEmptyString(projectId)
    ? projectId
    : undefined;

  for (let index = 0; index < length; index += 1) {
    const name = `events[${index}]`;
    let seqValue;
    try {
      if (!Object.hasOwn(events, index)) {
        record('EVENT_SLOT_MISSING', `${name} is required`, name, index);
        continue;
      }
      const event = events[index];
      if (!isRecord(event)) {
        record('EVENT_NOT_RECORD', `${name} must be an object`, name, index);
        continue;
      }

      const seqInspection = inspectEnumerableDataProperty(event, 'seq');
      if (seqInspection.ok && isPositiveSafeInteger(seqInspection.value)) {
        seqValue = seqInspection.value;
      }

      const envelopeView = {};
      let envelopeClean = true;
      for (const key of EVENT_ENVELOPE_FIELDS) {
        const inspected = inspectEnumerableDataProperty(event, key);
        if (!inspected.ok) {
          envelopeClean = false;
          record(
            inspected.reason === 'missing' ? 'FIELD_REQUIRED' : 'FIELD_NOT_ENUMERABLE_DATA_PROPERTY',
            inspected.reason === 'missing'
              ? `${name}.${key} is required`
              : `${name}.${key} must be an enumerable data property`,
            `${name}.${key}`, index, seqValue
          );
          continue;
        }
        envelopeView[key] = inspected.value;
      }

      if (Object.hasOwn(envelopeView, 'eventSchema') && envelopeView.eventSchema !== EVENT_SCHEMA) {
        envelopeClean = false;
        record('EVENT_SCHEMA_UNSUPPORTED', `${name}.eventSchema is unsupported`,
          `${name}.eventSchema`, index, seqValue);
      }
      if (Object.hasOwn(envelopeView, 'eventVersion') && envelopeView.eventVersion !== EVENT_VERSION) {
        envelopeClean = false;
        record('EVENT_VERSION_UNSUPPORTED', `${name}.eventVersion is unsupported`,
          `${name}.eventVersion`, index, seqValue);
      }
      if (Object.hasOwn(envelopeView, 'seq')) {
        if (!isPositiveSafeInteger(envelopeView.seq)) {
          envelopeClean = false;
          record('SEQ_INVALID', `${name}.seq must be a positive safe integer`,
            `${name}.seq`, index, seqValue);
        } else if (envelopeView.seq !== index + 1) {
          envelopeClean = false;
          record('SEQ_DISCONTINUOUS', `${name}.seq is discontinuous`,
            `${name}.seq`, index, seqValue);
        }
      }
      if (Object.hasOwn(envelopeView, 'revision') && !isPositiveSafeInteger(envelopeView.revision)) {
        envelopeClean = false;
        record('REVISION_INVALID', `${name}.revision must be a positive safe integer`,
          `${name}.revision`, index, seqValue);
      }
      if (Object.hasOwn(envelopeView, 'timestamp')) {
        if (envelopeView.timestamp === undefined) {
          envelopeClean = false;
          record('TIMESTAMP_REQUIRED', `${name}.timestamp is required`,
            `${name}.timestamp`, index, seqValue);
        } else if (!isValidTimestamp(envelopeView.timestamp)) {
          envelopeClean = false;
          record('TIMESTAMP_INVALID', `${name}.timestamp must be a valid timestamp string`,
            `${name}.timestamp`, index, seqValue);
        }
      }
      if (Object.hasOwn(envelopeView, 'actorId') && !isNonEmptyString(envelopeView.actorId)) {
        envelopeClean = false;
        record('ACTOR_ID_INVALID', `${name}.actorId must be a non-empty string`,
          `${name}.actorId`, index, seqValue);
      }
      if (Object.hasOwn(envelopeView, 'projectId')) {
        if (!isNonEmptyString(envelopeView.projectId)) {
          envelopeClean = false;
          record('PROJECT_ID_INVALID', `${name}.projectId must be a non-empty string`,
            `${name}.projectId`, index, seqValue);
        } else if (logProjectId === undefined) {
          logProjectId = envelopeView.projectId;
        } else if (envelopeView.projectId !== logProjectId) {
          envelopeClean = false;
          record('PROJECT_ID_MISMATCH', `${name}.projectId does not match the event log`,
            `${name}.projectId`, index, seqValue);
        }
      }
      if (Object.hasOwn(envelopeView, 'claimId') && !isNonEmptyString(envelopeView.claimId)) {
        envelopeClean = false;
        record('CLAIM_ID_INVALID', `${name}.claimId must be a non-empty string`,
          `${name}.claimId`, index, seqValue);
      }
      if (Object.hasOwn(envelopeView, 'action')) {
        if (!isNonEmptyString(envelopeView.action)) {
          envelopeClean = false;
          record('ACTION_INVALID', `${name}.action must be a non-empty string`,
            `${name}.action`, index, seqValue);
        } else if (!ACTIONS.has(envelopeView.action)) {
          envelopeClean = false;
          record('ACTION_UNSUPPORTED', `${name}.action is unsupported`,
            `${name}.action`, index, seqValue);
        }
      }

      if (!envelopeClean) continue;

      const prior = states.get(envelopeView.claimId);
      const expectedRevision = prior === undefined ? 1 : prior.revision + 1;
      let eventClean = true;
      if (envelopeView.revision !== expectedRevision) {
        eventClean = false;
        record('REVISION_DISCONTINUOUS', `${name}.revision is discontinuous`,
          `${name}.revision`, index, seqValue);
      }

      if (envelopeView.action === 'put') {
        if (prior !== undefined) {
          eventClean = false;
          record('DUPLICATE_CLAIM_CREATION', `${name}.action duplicates a claim creation`,
            `${name}.action`, index, seqValue);
        } else {
          const claimInspection = inspectEnumerableDataProperty(event, 'claim');
          if (!claimInspection.ok) {
            eventClean = false;
            record(
              claimInspection.reason === 'missing' ? 'FIELD_REQUIRED' : 'FIELD_NOT_ENUMERABLE_DATA_PROPERTY',
              claimInspection.reason === 'missing'
                ? `${name}.claim is required`
                : `${name}.claim must be an enumerable data property`,
              `${name}.claim`, index, seqValue
            );
          } else if (!isRecord(claimInspection.value)) {
            eventClean = false;
            record('CLAIM_NOT_RECORD', `${name}.claim must be an object`,
              `${name}.claim`, index, seqValue);
          } else {
            const claim = claimInspection.value;
            const claimView = {};
            let claimClean = true;
            for (const key of CLAIM_SNAPSHOT_FIELDS) {
              const inspected = inspectEnumerableDataProperty(claim, key);
              if (!inspected.ok) {
                claimClean = false;
                record(
                  inspected.reason === 'missing' ? 'FIELD_REQUIRED' : 'FIELD_NOT_ENUMERABLE_DATA_PROPERTY',
                  inspected.reason === 'missing'
                    ? `${name}.claim.${key} is required`
                    : `${name}.claim.${key} must be an enumerable data property`,
                  `${name}.claim.${key}`, index, seqValue
                );
                continue;
              }
              claimView[key] = inspected.value;
            }

            if (Object.hasOwn(claimView, 'projectId') && Object.hasOwn(claimView, 'claimId') &&
                Object.hasOwn(claimView, 'authorId') &&
                (claimView.projectId !== envelopeView.projectId ||
                 claimView.claimId !== envelopeView.claimId ||
                 claimView.authorId !== envelopeView.actorId)) {
              claimClean = false;
              record('CLAIM_IDENTITY_MISMATCH',
                `${name}.claim identity does not match the event envelope`,
                `${name}.claim`, index, seqValue);
            }
            for (const key of ['subject', 'predicate', 'authorId', 'scope', 'sensitivity']) {
              if (Object.hasOwn(claimView, key) && !isNonEmptyString(claimView[key])) {
                claimClean = false;
                record('CLAIM_FIELD_INVALID', `${name}.claim.${key} must be a non-empty string`,
                  `${name}.claim.${key}`, index, seqValue);
              }
            }
            if (Object.hasOwn(claimView, 'scope') && claimView.scope !== 'project') {
              claimClean = false;
              record('CLAIM_SCOPE_UNSUPPORTED', `${name}.claim.scope is unsupported`,
                `${name}.claim.scope`, index, seqValue);
            }
            if (Object.hasOwn(claimView, 'content') && claimView.content === undefined) {
              claimClean = false;
              record('CLAIM_CONTENT_REQUIRED', `${name}.claim.content is required`,
                `${name}.claim.content`, index, seqValue);
            }
            if (Object.hasOwn(claimView, 'visibility') && !VISIBILITIES.has(claimView.visibility)) {
              claimClean = false;
              record('CLAIM_VISIBILITY_INVALID', `${name}.claim.visibility is invalid`,
                `${name}.claim.visibility`, index, seqValue);
            }
            if (Object.hasOwn(claimView, 'status') && claimView.status !== 'candidate') {
              claimClean = false;
              record('CLAIM_STATUS_INVALID', `${name}.claim must start as candidate`,
                `${name}.claim.status`, index, seqValue);
            }
            if (Object.hasOwn(claimView, 'provenance') &&
                (claimView.provenance === undefined || claimView.provenance === null)) {
              claimClean = false;
              record('CLAIM_PROVENANCE_REQUIRED', `${name}.claim.provenance is required`,
                `${name}.claim.provenance`, index, seqValue);
            }
            if (Object.hasOwn(claimView, 'allowedPrincipals')) {
              if (!Array.isArray(claimView.allowedPrincipals)) {
                claimClean = false;
                record('CLAIM_ALLOWED_PRINCIPALS_INVALID',
                  `${name}.claim.allowedPrincipals must be an array`,
                  `${name}.claim.allowedPrincipals`, index, seqValue);
              } else {
                claimView.allowedPrincipals.forEach((principal, entryIndex) => {
                  if (!isNonEmptyString(principal)) {
                    claimClean = false;
                    record('CLAIM_ALLOWED_PRINCIPALS_INVALID',
                      `${name}.claim.allowedPrincipals[${entryIndex}] must be a non-empty string`,
                      `${name}.claim.allowedPrincipals[${entryIndex}]`, index, seqValue);
                  }
                });
              }
            }
            const observedAtRead = readProperty(claim, 'observedAt');
            if (!observedAtRead.ok) {
              claimClean = false;
              record('EVENT_INSPECTION_FAILED',
                `${name}.claim.observedAt could not be inspected safely`,
                `${name}.claim.observedAt`, index, seqValue);
            } else if (observedAtRead.value !== undefined &&
                !isValidTimestamp(observedAtRead.value)) {
              claimClean = false;
              record('CLAIM_TIMESTAMP_INVALID',
                `${name}.claim.observedAt must be a valid timestamp string`,
                `${name}.claim.observedAt`, index, seqValue);
            }
            const expiresAtRead = readProperty(claim, 'expiresAt');
            if (!expiresAtRead.ok) {
              claimClean = false;
              record('EVENT_INSPECTION_FAILED',
                `${name}.claim.expiresAt could not be inspected safely`,
                `${name}.claim.expiresAt`, index, seqValue);
            } else if (expiresAtRead.value !== undefined &&
                !isValidTimestamp(expiresAtRead.value)) {
              claimClean = false;
              record('CLAIM_TIMESTAMP_INVALID',
                `${name}.claim.expiresAt must be a valid timestamp string`,
                `${name}.claim.expiresAt`, index, seqValue);
            }

            eventClean = eventClean && claimClean;
            if (eventClean) {
              states.set(envelopeView.claimId, {
                revision: envelopeView.revision,
                status: 'candidate',
                subject: claimView.subject,
                predicate: claimView.predicate
              });
            }
          }
        }
      } else {
        if (prior === undefined) {
          eventClean = false;
          record('ACTION_PRECEDES_CLAIM_CREATION', `${name}.action precedes claim creation`,
            `${name}.action`, index, seqValue);
        } else {
          const fromStatusRead = readProperty(event, 'fromStatus');
          if (!fromStatusRead.ok) {
            record('EVENT_INSPECTION_FAILED', `${name}.fromStatus could not be inspected safely`,
              `${name}.fromStatus`, index, seqValue);
            continue;
          }
          const reasonRead = readProperty(event, 'reason');
          if (!reasonRead.ok) {
            record('EVENT_INSPECTION_FAILED', `${name}.reason could not be inspected safely`,
              `${name}.reason`, index, seqValue);
            continue;
          }
          const toStatusRead = readProperty(event, 'toStatus');
          if (!toStatusRead.ok) {
            record('EVENT_INSPECTION_FAILED', `${name}.toStatus could not be inspected safely`,
              `${name}.toStatus`, index, seqValue);
            continue;
          }

          if (fromStatusRead.value !== prior.status) {
            eventClean = false;
            record('FROM_STATUS_MISMATCH', `${name}.fromStatus does not match prior state`,
              `${name}.fromStatus`, index, seqValue);
          }
          if (!isNonEmptyString(reasonRead.value)) {
            eventClean = false;
            record('REASON_REQUIRED', `${name}.reason must be a non-empty string`,
              `${name}.reason`, index, seqValue);
          }

          if (envelopeView.action === 'approve') {
            if (prior.status !== 'candidate' || toStatusRead.value !== 'approved') {
              eventClean = false;
              record('TRANSITION_INVALID', `${name} has an invalid approval transition`,
                `${name}.action`, index, seqValue);
            }
          } else if (envelopeView.action === 'dispute') {
            if (!['candidate', 'approved'].includes(prior.status) ||
                toStatusRead.value !== 'disputed') {
              eventClean = false;
              record('TRANSITION_INVALID', `${name} has an invalid dispute transition`,
                `${name}.action`, index, seqValue);
            }
          } else {
            if (prior.status === 'superseded' || toStatusRead.value !== 'superseded') {
              eventClean = false;
              record('TRANSITION_INVALID', `${name} has an invalid supersession transition`,
                `${name}.action`, index, seqValue);
            }
            const replacementClaimIdRead = readProperty(event, 'replacementClaimId');
            if (!replacementClaimIdRead.ok) {
              record('EVENT_INSPECTION_FAILED',
                `${name}.replacementClaimId could not be inspected safely`,
                `${name}.replacementClaimId`, index, seqValue);
              continue;
            }
            if (!isNonEmptyString(replacementClaimIdRead.value)) {
              eventClean = false;
              record('REPLACEMENT_CLAIM_ID_REQUIRED',
                `${name}.replacementClaimId must be a non-empty string`,
                `${name}.replacementClaimId`, index, seqValue);
            } else {
              const replacementStatusRead = readProperty(event, 'replacementStatus');
              if (!replacementStatusRead.ok) {
                record('EVENT_INSPECTION_FAILED',
                  `${name}.replacementStatus could not be inspected safely`,
                  `${name}.replacementStatus`, index, seqValue);
                continue;
              }
              const replacement = states.get(replacementClaimIdRead.value);
              if (replacementClaimIdRead.value === envelopeView.claimId ||
                  replacement?.status !== 'approved' ||
                  replacementStatusRead.value !== 'approved') {
                eventClean = false;
                record('SUPERSESSION_REPLACEMENT_INVALID',
                  `${name} has an invalid supersession replacement`,
                  `${name}.action`, index, seqValue);
              } else if (replacement.subject !== prior.subject ||
                         replacement.predicate !== prior.predicate) {
                eventClean = false;
                record('SUPERSESSION_UNRELATED',
                  `${name} has an unrelated supersession replacement`,
                  `${name}.action`, index, seqValue);
              }
            }
          }

          if (eventClean) {
            states.set(envelopeView.claimId, {
              revision: envelopeView.revision,
              status: toStatusRead.value,
              subject: prior.subject,
              predicate: prior.predicate
            });
          }
        }
      }
    } catch {
      record('EVENT_INSPECTION_FAILED', `${name} could not be inspected safely`, name, index, seqValue);
    }
  }

  if (errors.length === 0) {
    try {
      copy(events);
    } catch {
      record('EVENT_INSPECTION_FAILED', 'events could not be cloned safely', 'events');
    }
  }

  return { valid: errors.length === 0, errors };
}

function assertCanonicalJsonValue(value, name, ancestors = new Set()) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${name} must contain only finite numbers`);
    return;
  }
  if (typeof value !== 'object') {
    throw new TypeError(`${name} contains an unsupported ${typeof value} value`);
  }
  if (ancestors.has(value)) throw new TypeError(`${name} contains a circular reference`);

  ancestors.add(value);
  if (Array.isArray(value)) {
    const keys = Reflect.ownKeys(value);
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) throw new TypeError(`${name}[${index}] is required`);
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw new TypeError(`${name}[${index}] must be an enumerable data property`);
      }
      assertCanonicalJsonValue(descriptor.value, `${name}[${index}]`, ancestors);
    }
    if (keys.some((key) => key !== 'length' &&
        (typeof key === 'symbol' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length))) {
      throw new TypeError(`${name} contains an unsupported array property`);
    }
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${name} contains an unsupported object value`);
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === 'symbol') throw new TypeError(`${name} contains an unsupported symbol key`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw new TypeError(`${name}.${key} must be an enumerable data property`);
      }
      assertCanonicalJsonValue(descriptor.value, `${name}.${key}`, ancestors);
    }
  }
  ancestors.delete(value);
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function canonicalizeValidatedEvents(normalized, originalForInspection) {
  // Inspect both values: structuredClone intentionally drops symbol-keyed properties.
  assertCanonicalJsonValue(originalForInspection, 'events');
  assertCanonicalJsonValue(normalized, 'events');
  return canonicalJson({
    canonicalizationSchema: EVENT_LOG_CANONICALIZATION_SCHEMA,
    canonicalizationVersion: EVENT_LOG_CANONICALIZATION_VERSION,
    events: normalized
  });
}

function canonicalizeEventLog(events, options = {}) {
  const normalized = validateEventLog(events, options);
  return canonicalizeValidatedEvents(normalized, events);
}

function computeEventLogDigest(events, options = {}) {
  return createHash('sha256').update(canonicalizeEventLog(events, options), 'utf8').digest('hex');
}

function digestEventRange(events, normalizedEvents, fromSeq, toSeq) {
  // The caller's raw input is inspected for canonical-JSON cleanliness (catching
  // symbol keys and the like that structuredClone would silently drop), while the
  // bytes come from the validated defensive clone sliced to the inclusive range.
  const range = normalizedEvents.slice(fromSeq - 1, toSeq);
  return createHash('sha256')
    .update(canonicalizeValidatedEvents(range, events), 'utf8')
    .digest('hex');
}

function computeEventLogRangeDigest(events, fromSeq, toSeq, options = {}) {
  requirePositiveSafeInteger(fromSeq, 'fromSeq');
  requirePositiveSafeInteger(toSeq, 'toSeq');
  if (fromSeq > toSeq) throw new Error('fromSeq must be less than or equal to toSeq');
  const normalized = validateEventLog(events, options);
  if (toSeq > normalized.length) throw new Error('toSeq exceeds the event log length');
  return digestEventRange(events, normalized, fromSeq, toSeq);
}

function verifyAuthorityContextEventLog(context, events, options = {}) {
  // Inputs must be well-formed per the existing pure boundaries; structural and
  // project-pinning problems throw, while coverage/digest mismatches are reported
  // as a consumable result so an adapter can inspect every inconsistency at once.
  const normalizedContext = normalizeBoundAuthorityContext(context, options);
  const normalizedEvents = validateEventLog(events, options);
  const eventsProjectId = normalizedEvents.length > 0 ? normalizedEvents[0].projectId : undefined;
  if (eventsProjectId !== undefined && normalizedContext.projectId !== eventsProjectId) {
    throw new Error('context.projectId does not match the event log project');
  }

  const { fromSeq, toSeq } = normalizedContext;
  const withinLog = toSeq <= normalizedEvents.length;
  const errors = [];
  if (!withinLog) {
    errors.push(`context.toSeq exceeds the event log length (${normalizedEvents.length})`);
  }

  let digest;
  if (Object.hasOwn(normalizedContext, 'eventLogDigest')) {
    digest = {
      algorithm: normalizedContext.eventLogDigest.algorithm,
      verified: false
    };
    if (withinLog) {
      digest.verified = digestEventRange(events, normalizedEvents, fromSeq, toSeq) ===
        normalizedContext.eventLogDigest.digest;
      if (!digest.verified) {
        errors.push('context.eventLogDigest.digest does not match the covered event range');
      }
    } else {
      errors.push('context.eventLogDigest cannot be verified without a valid covered range');
    }
  }

  const result = {
    valid: errors.length === 0,
    range: { fromSeq, toSeq, eventCount: normalizedEvents.length, withinLog }
  };
  if (digest !== undefined) result.digest = digest;
  if (errors.length > 0) result.errors = errors;
  return result;
}

function verifyEventLogDigest(events, expectedDigest, options = {}) {
  if (typeof expectedDigest !== 'string' || !/^[0-9a-f]{64}$/.test(expectedDigest)) {
    throw new TypeError('expectedDigest must be 64 lowercase hexadecimal characters');
  }
  return computeEventLogDigest(events, options) === expectedDigest;
}

function normalizeAuthorityContext(context, { projectId } = {}) {
  requireRecord(context, 'context');
  if (projectId !== undefined) requireNonEmptyString(projectId, 'projectId');
  for (const field of [
    'authoritySchema', 'authorityVersion', 'projectId',
    'authorizedPrincipals', 'privateClaimAudiences'
  ]) {
    if (!Object.hasOwn(context, field)) throw new TypeError(`context.${field} is required`);
  }
  if (context.authoritySchema !== AUTHORITY_CONTEXT_SCHEMA) {
    throw new Error('context.authoritySchema is unsupported');
  }
  if (context.authorityVersion !== AUTHORITY_CONTEXT_VERSION) {
    throw new Error('context.authorityVersion is unsupported');
  }
  requireNonEmptyString(context.projectId, 'context.projectId');
  if (projectId !== undefined && context.projectId !== projectId) {
    throw new Error('context.projectId does not match the expected project');
  }
  validateUniqueStringList(context.authorizedPrincipals, 'context.authorizedPrincipals');
  if (!Array.isArray(context.privateClaimAudiences)) {
    throw new TypeError('context.privateClaimAudiences must be an array');
  }

  const authorized = new Set(context.authorizedPrincipals);
  const claimIds = new Set();
  for (let index = 0; index < context.privateClaimAudiences.length; index += 1) {
    const name = `context.privateClaimAudiences[${index}]`;
    if (!Object.hasOwn(context.privateClaimAudiences, index)) {
      throw new TypeError(`${name} is required`);
    }
    const audience = context.privateClaimAudiences[index];
    requireRecord(audience, name);
    for (const field of ['claimId', 'authorId', 'allowedPrincipals']) {
      if (!Object.hasOwn(audience, field)) throw new TypeError(`${name}.${field} is required`);
    }
    requireNonEmptyString(audience.claimId, `${name}.claimId`);
    requireNonEmptyString(audience.authorId, `${name}.authorId`);
    validateUniqueStringList(audience.allowedPrincipals, `${name}.allowedPrincipals`);
    if (claimIds.has(audience.claimId)) {
      throw new Error(`${name}.claimId duplicates or conflicts with another audience rule`);
    }
    claimIds.add(audience.claimId);
    if (!authorized.has(audience.authorId)) {
      throw new Error(`${name}.authorId is not an authorized project principal`);
    }
    if (audience.allowedPrincipals.includes(audience.authorId)) {
      throw new Error(`${name}.allowedPrincipals conflicts with authorId`);
    }
  }

  return copy(context);
}

function normalizeBoundAuthorityContext(context, options = {}) {
  const normalized = normalizeAuthorityContext(context, options);
  for (const field of ['authorityContextId', 'fromSeq', 'toSeq']) {
    if (!Object.hasOwn(normalized, field)) throw new TypeError(`context.${field} is required`);
  }
  requireNonEmptyString(normalized.authorityContextId, 'context.authorityContextId');
  requirePositiveSafeInteger(normalized.fromSeq, 'context.fromSeq');
  requirePositiveSafeInteger(normalized.toSeq, 'context.toSeq');
  if (normalized.fromSeq > normalized.toSeq) {
    throw new Error('context.fromSeq must be less than or equal to context.toSeq');
  }
  if (Object.hasOwn(normalized, 'coverageMode') && normalized.coverageMode !== 'closed') {
    throw new Error("context.coverageMode must be 'closed'");
  }
  if (Object.hasOwn(normalized, 'coverageIntent') &&
      !COVERAGE_INTENTS.has(normalized.coverageIntent)) {
    throw new Error("context.coverageIntent must be 'complete' or 'partial'");
  }
  if (Object.hasOwn(normalized, 'supersedes')) {
    requireRecord(normalized.supersedes, 'context.supersedes');
    for (const field of ['authorityContextId', 'projectId', 'fromSeq', 'toSeq']) {
      if (!Object.hasOwn(normalized.supersedes, field)) {
        throw new TypeError(`context.supersedes.${field} is required`);
      }
    }
    requireNonEmptyString(
      normalized.supersedes.authorityContextId,
      'context.supersedes.authorityContextId'
    );
    requireNonEmptyString(normalized.supersedes.projectId, 'context.supersedes.projectId');
    requirePositiveSafeInteger(normalized.supersedes.fromSeq, 'context.supersedes.fromSeq');
    requirePositiveSafeInteger(normalized.supersedes.toSeq, 'context.supersedes.toSeq');
    if (normalized.supersedes.authorityContextId === normalized.authorityContextId) {
      throw new Error('context.supersedes.authorityContextId must identify a different snapshot');
    }
    if (normalized.supersedes.projectId !== normalized.projectId) {
      throw new Error('context.supersedes.projectId must match context.projectId');
    }
    if (normalized.supersedes.fromSeq !== normalized.fromSeq ||
        normalized.supersedes.toSeq !== normalized.toSeq) {
      throw new Error('context.supersedes range must match the authority snapshot range');
    }
  }

  const claimContentFields = ['claim', 'claims', 'content', 'claimContent', 'claimContents'];
  for (const field of claimContentFields) {
    if (Object.hasOwn(normalized, field)) {
      throw new Error(`context.${field} is unsupported in an authority snapshot`);
    }
  }
  normalized.privateClaimAudiences.forEach((audience, index) => {
    if (claimContentFields.some((field) => Object.hasOwn(audience, field))) {
      throw new Error(
        `context.privateClaimAudiences[${index}] contains unsupported claim content`
      );
    }
  });

  if (Object.hasOwn(normalized, 'eventLogDigest')) {
    requireRecord(normalized.eventLogDigest, 'context.eventLogDigest');
    for (const field of ['algorithm', 'digest']) {
      if (!Object.hasOwn(normalized.eventLogDigest, field)) {
        throw new TypeError(`context.eventLogDigest.${field} is required`);
      }
    }
    if (normalized.eventLogDigest.algorithm !== 'sha256') {
      throw new Error('context.eventLogDigest.algorithm is unsupported');
    }
    if (typeof normalized.eventLogDigest.digest !== 'string' ||
        !/^[0-9a-f]{64}$/.test(normalized.eventLogDigest.digest)) {
      throw new TypeError(
        'context.eventLogDigest.digest must be exactly 64 lowercase hexadecimal characters'
      );
    }
    if (claimContentFields.some((field) =>
      Object.hasOwn(normalized.eventLogDigest, field))) {
      throw new Error('context.eventLogDigest contains unsupported claim content');
    }
  }

  return normalized;
}

function normalizeAuthorityContextRanges(contexts, options = {}) {
  if (!Array.isArray(contexts)) throw new TypeError('contexts must be an array');
  for (let index = 0; index < contexts.length; index += 1) {
    if (!Object.hasOwn(contexts, index)) {
      throw new TypeError(`contexts[${index}] is required`);
    }
  }
  const normalized = contexts.map((context) =>
    normalizeBoundAuthorityContext(context, options));
  const ids = new Set();
  let projectId = options.projectId;

  normalized.forEach((context, index) => {
    if (projectId === undefined) projectId = context.projectId;
    if (context.projectId !== projectId) {
      throw new Error(`contexts[${index}].projectId does not match the authority range set`);
    }
    if (ids.has(context.authorityContextId)) {
      throw new Error(`contexts[${index}].authorityContextId is duplicated`);
    }
    ids.add(context.authorityContextId);
  });

  normalized.sort((left, right) => left.fromSeq - right.fromSeq || left.toSeq - right.toSeq);
  for (let index = 1; index < normalized.length; index += 1) {
    const prior = normalized[index - 1];
    const current = normalized[index];
    if (current.fromSeq <= prior.toSeq) {
      throw new Error(`contexts[${index}] overlaps the preceding authority range`);
    }
    if (current.fromSeq !== prior.toSeq + 1) {
      throw new Error(`contexts[${index}] leaves a gap after the preceding authority range`);
    }
  }

  const declaredCoverageIntents = new Set(normalized
    .filter((context) => Object.hasOwn(context, 'coverageIntent'))
    .map((context) => context.coverageIntent));
  if (declaredCoverageIntents.size > 0 &&
      normalized.some((context) => !Object.hasOwn(context, 'coverageIntent'))) {
    throw new Error('authority range set coverageIntent must be declared on every range');
  }
  if (declaredCoverageIntents.size > 1) {
    throw new Error('authority range set coverageIntent must be consistent');
  }
  if (declaredCoverageIntents.has('complete') && normalized[0].fromSeq !== 1) {
    throw new Error('a complete authority range set must start at seq 1');
  }

  return normalized;
}

function normalizeAuthorityContextLineage(contexts, options = {}) {
  if (!Array.isArray(contexts)) throw new TypeError('contexts must be an array');
  for (let index = 0; index < contexts.length; index += 1) {
    if (!Object.hasOwn(contexts, index)) {
      throw new TypeError(`contexts[${index}] is required`);
    }
  }
  const normalized = contexts.map((context) =>
    normalizeBoundAuthorityContext(context, options));
  const byId = new Map();
  let projectId = options.projectId;

  normalized.forEach((context, index) => {
    if (projectId === undefined) projectId = context.projectId;
    if (context.projectId !== projectId) {
      throw new Error(`contexts[${index}].projectId does not match the authority lineage set`);
    }
    if (byId.has(context.authorityContextId)) {
      throw new Error(`contexts[${index}].authorityContextId is duplicated`);
    }
    byId.set(context.authorityContextId, context);
  });

  const successorByTarget = new Map();
  normalized.forEach((context, index) => {
    if (!Object.hasOwn(context, 'supersedes')) return;
    const targetId = context.supersedes.authorityContextId;
    const target = byId.get(targetId);
    if (!target) {
      throw new Error(`contexts[${index}].supersedes target is absent from the lineage set`);
    }
    if (target.projectId !== context.supersedes.projectId ||
        target.fromSeq !== context.supersedes.fromSeq ||
        target.toSeq !== context.supersedes.toSeq) {
      throw new Error(`contexts[${index}].supersedes target metadata does not match its snapshot`);
    }
    if (successorByTarget.has(targetId)) {
      throw new Error(`contexts[${index}].supersedes target has multiple successors`);
    }
    successorByTarget.set(targetId, context.authorityContextId);
  });

  for (const context of normalized) {
    const seen = new Set();
    let current = context;
    while (Object.hasOwn(current, 'supersedes')) {
      if (seen.has(current.authorityContextId)) {
        throw new Error('authority lineage set contains a cycle');
      }
      seen.add(current.authorityContextId);
      current = byId.get(current.supersedes.authorityContextId);
    }
  }

  return normalized;
}

function normalizeAuthorityContextChain(contexts, options = {}) {
  const normalized = normalizeAuthorityContextLineage(contexts, options);
  if (normalized.length === 0) return normalized;

  const rootCount = normalized.filter((context) =>
    !Object.hasOwn(context, 'supersedes')).length;
  if (rootCount !== 1) {
    throw new Error('authority lineage chain must contain exactly one root');
  }

  return normalized;
}

class ProjectMemory {
  #projectId;
  #principalId;
  #authorizedPrincipals;
  #clock;
  #claims = new Map();
  #events = [];
  #nextSeq = 1;
  #nextRevisionByClaim = new Map();

  constructor({ projectId, principalId, authorizedPrincipals = [], clock = () => new Date() } = {}) {
    requireNonEmptyString(projectId, 'projectId');
    if (principalId !== undefined) requireNonEmptyString(principalId, 'principalId');
    validateStringList(authorizedPrincipals, 'authorizedPrincipals');
    if (typeof clock !== 'function') throw new TypeError('clock must be a function');

    this.#projectId = projectId;
    this.#principalId = principalId;
    this.#clock = clock;
    this.#authorizedPrincipals = new Set(authorizedPrincipals);
    if (principalId !== undefined) this.#authorizedPrincipals.add(principalId);
  }

  static validateEvents(events, options = {}) {
    return validateEventLog(events, options);
  }

  static diagnoseEvents(events, options = {}) {
    return diagnoseEventLog(events, options);
  }

  static canonicalizeEvents(events, options = {}) {
    return canonicalizeEventLog(events, options);
  }

  static computeEventLogDigest(events, options = {}) {
    return computeEventLogDigest(events, options);
  }

  static verifyEventLogDigest(events, expectedDigest, options = {}) {
    return verifyEventLogDigest(events, expectedDigest, options);
  }

  static computeEventLogRangeDigest(events, fromSeq, toSeq, options = {}) {
    return computeEventLogRangeDigest(events, fromSeq, toSeq, options);
  }

  static verifyAuthorityContextEventLog(context, events, options = {}) {
    return verifyAuthorityContextEventLog(context, events, options);
  }

  static normalizeAuthorityContext(context, options = {}) {
    return normalizeAuthorityContext(context, options);
  }

  static normalizeBoundAuthorityContext(context, options = {}) {
    return normalizeBoundAuthorityContext(context, options);
  }

  static normalizeAuthorityContextRanges(contexts, options = {}) {
    return normalizeAuthorityContextRanges(contexts, options);
  }

  static normalizeAuthorityContextLineage(contexts, options = {}) {
    return normalizeAuthorityContextLineage(contexts, options);
  }

  static normalizeAuthorityContextChain(contexts, options = {}) {
    return normalizeAuthorityContextChain(contexts, options);
  }

  putClaim({
    claimId, subject, predicate, content, authorId, scope, visibility = 'project',
    status = 'candidate', provenance, sensitivity = 'normal', observedAt, expiresAt,
    allowedPrincipals = []
  } = {}) {
    requireNonEmptyString(claimId, 'claimId');
    requireNonEmptyString(subject, 'subject');
    requireNonEmptyString(predicate, 'predicate');
    requireNonEmptyString(authorId, 'authorId');
    this.#requireAuthorizedPrincipal(authorId, 'authorId');
    const claimScope = scope === undefined ? 'project' : scope;
    requireNonEmptyString(claimScope, 'scope');
    if (claimScope !== 'project') throw new Error('scope must be project');
    if (content === undefined) throw new TypeError('content is required');
    if (!VISIBILITIES.has(visibility)) throw new TypeError('visibility must be project or private');
    if (!STATUSES.has(status)) throw new TypeError('invalid status');
    if (status !== 'candidate') {
      throw new Error(
        'putClaim only accepts status=candidate; use approveClaim after review (direct approved import is unavailable in Phase 1)'
      );
    }
    requireNonEmptyString(sensitivity, 'sensitivity');
    validateStringList(allowedPrincipals, 'allowedPrincipals');
    validateTimestamp(observedAt, 'observedAt');
    validateTimestamp(expiresAt, 'expiresAt');
    if (!Object.hasOwn(arguments[0] || {}, 'provenance') || provenance === undefined || provenance === null) {
      throw new TypeError('provenance is required for candidate claims');
    }
    if (this.#claims.has(claimId)) throw new Error(`claim already exists: ${claimId}`);
    const now = this.#readClock();

    const claim = copy({
      projectId: this.#projectId,
      claimId,
      subject,
      predicate,
      content,
      authorId,
      scope: claimScope,
      visibility,
      status,
      ...(Object.hasOwn(arguments[0] || {}, 'provenance') ? { provenance } : {}),
      sensitivity,
      ...(observedAt !== undefined ? { observedAt } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      allowedPrincipals: [...new Set(allowedPrincipals)]
    });
    this.#claims.set(claimId, claim);
    this.#append(claimId, 'put', authorId, { claim }, now);
    return copy(claim);
  }

  approveClaim(claimId, { actorId, reason } = {}) {
    requireNonEmptyString(actorId, 'actorId');
    requireNonEmptyString(reason, 'reason');
    const claim = this.#requireMutationTarget(claimId, actorId);
    if (claim.status !== 'candidate') throw new Error('only a candidate claim can be approved');
    const now = this.#readClock();
    if (claim.expiresAt !== undefined && Date.parse(claim.expiresAt) <= now.time) {
      throw new Error('an expired candidate claim cannot be approved');
    }
    const fromStatus = claim.status;
    claim.status = 'approved';
    this.#append(claimId, 'approve', actorId, { reason, fromStatus, toStatus: claim.status }, now);
    return copy(claim);
  }

  disputeClaim(claimId, { actorId, reason, evidence } = {}) {
    requireNonEmptyString(actorId, 'actorId');
    requireNonEmptyString(reason, 'reason');
    const claim = this.#requireMutationTarget(claimId, actorId);
    if (claim.status === 'superseded') throw new Error('a superseded claim cannot be disputed');
    if (claim.status === 'disputed') throw new Error('claim is already disputed');
    const now = this.#readClock();
    const payload = { reason };
    if (Object.hasOwn(arguments[1] || {}, 'evidence')) payload.evidence = copy(evidence);
    const fromStatus = claim.status;
    claim.status = 'disputed';
    payload.fromStatus = fromStatus;
    payload.toStatus = claim.status;
    this.#append(claimId, 'dispute', actorId, payload, now);
    return copy(claim);
  }

  supersedeClaim(claimId, { actorId, replacementClaimId, reason } = {}) {
    requireNonEmptyString(actorId, 'actorId');
    requireNonEmptyString(replacementClaimId, 'replacementClaimId');
    requireNonEmptyString(reason, 'reason');
    const claim = this.#requireMutationTarget(claimId, actorId);
    if (replacementClaimId === claimId) throw new Error('a claim cannot supersede itself');
    const replacement = this.#requireMutationTarget(replacementClaimId, actorId);
    if (claim.status === 'superseded') throw new Error('claim is already superseded');
    if (replacement.status !== 'approved') throw new Error('replacement claim must be approved');
    const now = this.#readClock();
    if (replacement.expiresAt !== undefined && Date.parse(replacement.expiresAt) <= now.time) {
      throw new Error('replacement claim must not be expired');
    }
    if (claim.subject !== replacement.subject || claim.predicate !== replacement.predicate) {
      throw new Error('replacement claim must have the same subject and predicate');
    }
    if (!this.#audienceIncludes(replacement, claim)) {
      throw new Error('replacement claim audience must include the superseded claim audience');
    }
    const fromStatus = claim.status;
    claim.status = 'superseded';
    claim.replacementClaimId = replacementClaimId;
    this.#append(claimId, 'supersede', actorId, {
      reason, replacementClaimId, replacementStatus: replacement.status,
      fromStatus, toStatus: claim.status
    }, now);
    return copy(claim);
  }

  getClaim(claimId, { principalId = this.#principalId, includeCandidates = false, includeDisputed = false } = {}) {
    requireNonEmptyString(claimId, 'claimId');
    if (principalId !== undefined) requireNonEmptyString(principalId, 'principalId');
    const claim = this.#claims.get(claimId);
    if (!claim) return null;
    const now = this.#readClock();
    if (!this.#isReadable(claim, principalId, includeCandidates, includeDisputed, now.time)) return null;
    return copy(claim);
  }

  query({ principalId = this.#principalId, subject, predicate, includeCandidates = false, includeDisputed = false } = {}) {
    if (principalId !== undefined) requireNonEmptyString(principalId, 'principalId');
    if (subject !== undefined) requireNonEmptyString(subject, 'subject');
    if (predicate !== undefined) requireNonEmptyString(predicate, 'predicate');
    const now = this.#readClock();
    const results = [];
    for (const claim of this.#claims.values()) {
      if (subject !== undefined && claim.subject !== subject) continue;
      if (predicate !== undefined && claim.predicate !== predicate) continue;
      if (this.#isReadable(claim, principalId, includeCandidates, includeDisputed, now.time)) results.push(copy(claim));
    }
    return results;
  }

  history(claimId, { principalId = this.#principalId } = {}) {
    requireNonEmptyString(claimId, 'claimId');
    if (principalId !== undefined) requireNonEmptyString(principalId, 'principalId');
    const claim = this.#claims.get(claimId);
    if (!claim || !this.#canAccessClaim(claim, principalId)) return [];
    return copy(this.#events.filter((event) => event.claimId === claimId));
  }

  audit({ principalId = this.#principalId } = {}) {
    if (principalId !== undefined) requireNonEmptyString(principalId, 'principalId');
    return copy(this.#events.filter((event) => {
      const claim = this.#claims.get(event.claimId);
      return claim && this.#canAccessClaim(claim, principalId);
    }));
  }

  #isReadable(claim, principalId, includeCandidates, includeDisputed, now) {
    if (claim.expiresAt !== undefined && Date.parse(claim.expiresAt) <= now) return false;
    if (claim.status === 'candidate' && !includeCandidates) return false;
    if (claim.status === 'disputed' && !includeDisputed) return false;
    if (claim.status === 'superseded') return false;
    return this.#canAccessClaim(claim, principalId);
  }

  #canAccessClaim(claim, principalId) {
    if (principalId === undefined || !this.#authorizedPrincipals.has(principalId)) return false;
    return claim.visibility === 'project' ||
      principalId === claim.authorId || claim.allowedPrincipals.includes(principalId);
  }

  #requireAuthorizedPrincipal(principalId, name) {
    if (!this.#authorizedPrincipals.has(principalId)) {
      throw new Error(`${name} is not an authorized project principal`);
    }
  }

  #requireMutationTarget(claimId, actorId) {
    requireNonEmptyString(claimId, 'claimId');
    const claim = this.#claims.get(claimId);
    if (!this.#authorizedPrincipals.has(actorId) ||
        !claim || !this.#canAccessClaim(claim, actorId)) {
      throw new Error('claim is unavailable for mutation');
    }
    return claim;
  }

  #audienceIncludes(replacement, claim) {
    for (const principalId of this.#authorizedPrincipals) {
      if (this.#canAccessClaim(claim, principalId) &&
          !this.#canAccessClaim(replacement, principalId)) return false;
    }
    return true;
  }

  #readClock() {
    const value = this.#clock();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new TypeError('clock must return a valid Date');
    }
    return { time: value.getTime(), timestamp: value.toISOString() };
  }

  #append(claimId, action, actorId, details, now) {
    const revision = this.#nextRevisionByClaim.get(claimId) || 1;
    const event = copy({
      eventSchema: EVENT_SCHEMA,
      eventVersion: EVENT_VERSION,
      seq: this.#nextSeq,
      revision,
      timestamp: now.timestamp,
      actorId,
      projectId: this.#projectId,
      claimId,
      action,
      ...details
    });
    this.#events.push(event);
    this.#nextSeq += 1;
    this.#nextRevisionByClaim.set(claimId, revision + 1);
    return copy(event);
  }
}

module.exports = { ProjectMemory };
