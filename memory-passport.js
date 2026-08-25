'use strict';

const { randomUUID } = require('node:crypto');

function requireNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function copy(value) {
  return structuredClone(value);
}

function inline(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}

class MemoryPassport {
  #eventsByMemory = new Map();

  create({ memoryId = randomUUID(), actorAgentId, content, source } = {}) {
    requireNonEmptyString(memoryId, 'memoryId');
    requireNonEmptyString(actorAgentId, 'actorAgentId');
    if (this.#eventsByMemory.has(memoryId)) {
      throw new Error(`memory already exists: ${memoryId}`);
    }
    if (content === undefined) {
      throw new TypeError('content is required');
    }

    const payload = { content: copy(content) };
    if (Object.hasOwn(arguments[0] || {}, 'source')) payload.source = copy(source);
    return this.#append(memoryId, 'create', actorAgentId, payload);
  }

  update(memoryId, { actorAgentId, content, source } = {}) {
    this.#requireMemory(memoryId);
    requireNonEmptyString(actorAgentId, 'actorAgentId');
    if (this.current(memoryId).status === 'resolved') {
      throw new Error('a resolved memory must be disputed before it can be updated');
    }
    if (content === undefined) {
      throw new TypeError('content is required');
    }

    const options = arguments[1] || {};
    const payload = { content: copy(content) };
    if (Object.hasOwn(options, 'source')) payload.source = copy(source);
    return this.#append(memoryId, 'update', actorAgentId, payload);
  }

  dispute(memoryId, { actorAgentId, reason, source } = {}) {
    this.#requireMemory(memoryId);
    requireNonEmptyString(actorAgentId, 'actorAgentId');
    requireNonEmptyString(reason, 'reason');
    if (this.current(memoryId).status === 'disputed') {
      throw new Error('memory already has an open dispute');
    }

    const options = arguments[1] || {};
    const payload = { reason };
    if (Object.hasOwn(options, 'source')) payload.source = copy(source);
    return this.#append(memoryId, 'dispute', actorAgentId, payload);
  }

  requestReview(memoryId, { actorAgentId, reason, source } = {}) {
    this.#requireMemory(memoryId);
    requireNonEmptyString(actorAgentId, 'actorAgentId');
    requireNonEmptyString(reason, 'reason');
    const options = arguments[1] || {};
    if (!Object.hasOwn(options, 'source') || source === undefined || source === null) {
      throw new TypeError('source is required as independent review evidence');
    }
    if (this.current(memoryId).status === 'disputed') {
      throw new Error('memory already has an open dispute or review');
    }

    return this.#append(memoryId, 'review', actorAgentId, {
      reason,
      source: copy(source)
    });
  }

  resolve(memoryId, { adjudicatorAgentId, reason, decision, content, source } = {}) {
    this.#requireMemory(memoryId);
    requireNonEmptyString(adjudicatorAgentId, 'adjudicatorAgentId');
    requireNonEmptyString(reason, 'reason');
    requireNonEmptyString(decision, 'decision');
    if (this.current(memoryId).status !== 'disputed') {
      throw new Error('only a disputed memory can be resolved');
    }

    const options = arguments[1] || {};
    const payload = { reason, decision };
    if (Object.hasOwn(options, 'content')) payload.content = copy(content);
    if (Object.hasOwn(options, 'source')) payload.source = copy(source);
    return this.#append(memoryId, 'resolve', adjudicatorAgentId, payload);
  }

  history(memoryId) {
    this.#requireMemory(memoryId);
    return copy(this.#eventsByMemory.get(memoryId));
  }

  timeline(memoryId) {
    const events = this.history(memoryId);
    let status = 'active';

    return events.map((event) => {
      const entry = {
        seq: event.seq,
        eventId: event.eventId,
        timestamp: event.timestamp,
        actorAgentId: event.actorAgentId,
        eventType: event.eventType
      };

      if (event.eventType === 'create') {
        entry.summary = 'Created memory';
        entry.contentChanged = true;
      } else if (event.eventType === 'update') {
        entry.summary = 'Updated memory content';
        entry.contentChanged = true;
      } else if (event.eventType === 'dispute' || event.eventType === 'review') {
        const isReview = event.eventType === 'review';
        entry.summary = status === 'resolved' ? 'Reopened dispute' : 'Opened dispute';
        if (isReview) entry.summary = status === 'resolved' ? 'Requested review again' : 'Requested review';
        entry.reason = event.payload.reason;
        status = 'disputed';
      } else if (event.eventType === 'resolve') {
        entry.summary = `Resolved dispute: ${event.payload.decision}`;
        entry.reason = event.payload.reason;
        entry.decision = event.payload.decision;
        entry.contentChanged = Object.hasOwn(event.payload, 'content');
        status = 'resolved';
      }

      entry.sourceProvided = Object.hasOwn(event.payload, 'source');
      entry.statusAfter = status;
      return entry;
    });
  }

  formatTimeline(memoryId) {
    return this.timeline(memoryId).map((entry) => {
      const details = [inline(entry.summary)];
      if (entry.reason) details.push(`reason: ${inline(entry.reason)}`);
      if (entry.contentChanged) details.push('content changed');
      if (entry.sourceProvided) details.push('source provided');
      details.push(`status: ${entry.statusAfter}`);
      return `${entry.seq}. ${entry.timestamp} — ${inline(entry.actorAgentId)} — ${details.join('; ')}`;
    }).join('\n');
  }

  current(memoryId) {
    const events = this.history(memoryId);
    const created = events[0];
    const state = {
      memoryId,
      status: 'active',
      content: copy(created.payload.content),
      createdByAgentId: created.actorAgentId,
      lastEventId: created.eventId,
      seq: created.seq
    };
    if (Object.hasOwn(created.payload, 'source')) state.source = copy(created.payload.source);

    for (const event of events.slice(1)) {
      if (event.eventType === 'update') {
        state.content = copy(event.payload.content);
        if (Object.hasOwn(event.payload, 'source')) state.source = copy(event.payload.source);
        else delete state.source;
      } else if (event.eventType === 'dispute' || event.eventType === 'review') {
        state.status = 'disputed';
        if (event.eventType === 'review') {
          state.reviewReason = event.payload.reason;
          delete state.disputeReason;
        } else {
          state.disputeReason = event.payload.reason;
          delete state.reviewReason;
        }
        delete state.resolution;
      } else if (event.eventType === 'resolve') {
        state.status = 'resolved';
        state.resolution = {
          adjudicatorAgentId: event.actorAgentId,
          reason: event.payload.reason,
          decision: event.payload.decision
        };
        delete state.disputeReason;
        delete state.reviewReason;
        if (Object.hasOwn(event.payload, 'content')) {
          state.content = copy(event.payload.content);
          if (!Object.hasOwn(event.payload, 'source')) delete state.source;
        }
        if (Object.hasOwn(event.payload, 'source')) state.source = copy(event.payload.source);
      }
      state.lastEventId = event.eventId;
      state.seq = event.seq;
    }
    return copy(state);
  }

  #requireMemory(memoryId) {
    requireNonEmptyString(memoryId, 'memoryId');
    if (!this.#eventsByMemory.has(memoryId)) {
      throw new Error(`unknown memory: ${memoryId}`);
    }
  }

  #append(memoryId, eventType, actorAgentId, payload) {
    const events = this.#eventsByMemory.get(memoryId) || [];
    const event = {
      eventId: randomUUID(),
      memoryId,
      seq: events.length + 1,
      eventType,
      actorAgentId,
      timestamp: new Date().toISOString(),
      payload: copy(payload)
    };
    events.push(event);
    this.#eventsByMemory.set(memoryId, events);
    return copy(event);
  }
}

module.exports = { MemoryPassport };
