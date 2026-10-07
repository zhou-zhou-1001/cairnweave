'use strict';

class ProtocolError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ProtocolError';
    this.code = code;
    if (options.details !== undefined) this.details = Object.freeze({ ...options.details });
  }
}

class TransportError extends ProtocolError {
  constructor(code, message, options) {
    super(code, message, options);
    this.name = 'TransportError';
  }
}

module.exports = { ProtocolError, TransportError };
