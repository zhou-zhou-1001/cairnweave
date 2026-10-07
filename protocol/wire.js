'use strict';

function wireError(path, reason) {
  return new TypeError(`${path} ${reason}`);
}

function cloneWireValue(value, name = 'value') {
  const ancestors = new Set();

  function visit(current, path) {
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return current;
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw wireError(path, 'must be a finite number');
      if (Object.is(current, -0)) throw wireError(path, 'must not be negative zero');
      return current;
    }
    if (typeof current !== 'object') throw wireError(path, 'must contain only JSON-safe values');
    if (ancestors.has(current)) throw wireError(path, 'must not be circular');

    ancestors.add(current);
    let output;
    if (Array.isArray(current)) {
      if (Object.getOwnPropertySymbols(current).length > 0) throw wireError(path, 'must not have symbol properties');
      output = [];
      for (let index = 0; index < current.length; index += 1) {
        if (!Object.hasOwn(current, index)) throw wireError(`${path}[${index}]`, 'is required');
        output.push(visit(current[index], `${path}[${index}]`));
      }
      if (Object.keys(current).some((key) => !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= current.length)) {
        throw wireError(path, 'array must not have extra properties');
      }
      if (Object.getOwnPropertyNames(current).some((key) => key !== 'length' && !Object.prototype.propertyIsEnumerable.call(current, key))) {
        throw wireError(path, 'array must not have non-enumerable properties');
      }
    } else {
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) throw wireError(path, 'must be a plain object');
      if (Object.getOwnPropertySymbols(current).length > 0) throw wireError(path, 'must not have symbol properties');
      if (Object.getOwnPropertyNames(current).some((key) => !Object.prototype.propertyIsEnumerable.call(current, key))) {
        throw wireError(path, 'must not have non-enumerable properties');
      }
      output = {};
      for (const key of Object.keys(current)) {
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw wireError(`${path}.${key}`, 'must be a data property');
        output[key] = visit(descriptor.value, `${path}.${key}`);
      }
    }
    ancestors.delete(current);
    return output;
  }

  return visit(value, name);
}

function isWireValue(value) {
  try {
    cloneWireValue(value);
    return true;
  } catch {
    return false;
  }
}

module.exports = { cloneWireValue, isWireValue };
