'use strict';

class ResultStore {
  #byAgent = new Map();
  #allEvents = [];
  #sequence = 0;

  append(agentId, event) {
    if (typeof agentId !== 'string' || agentId.trim().length === 0) {
      throw new TypeError('agentId must be a non-empty string');
    }

    // Clone before advancing the sequence so a rejected value is not an event.
    const eventCopy = structuredClone(event);
    const stored = Object.freeze({
      agentId,
      sequence: ++this.#sequence,
      event: eventCopy
    });
    const partition = this.#byAgent.get(agentId) || [];
    partition.push(stored);
    this.#byAgent.set(agentId, partition);
    this.#allEvents.push(stored);
    return structuredClone(stored);
  }

  readAgent(agentId) {
    if (typeof agentId !== 'string' || agentId.trim().length === 0) {
      throw new TypeError('agentId must be a non-empty string');
    }
    return structuredClone(this.#byAgent.get(agentId) || []);
  }

  readAll() {
    return structuredClone(this.#allEvents);
  }
}

module.exports = { ResultStore };
