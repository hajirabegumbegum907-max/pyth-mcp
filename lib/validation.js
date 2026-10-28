'use strict';

const { ValidationError } = require('./errors');

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertObject(value, label) {
  if (!isObject(value)) throw new ValidationError(`${label} must be an object`);
}

function validateSchema(value, schema, label = 'value') {
  if (!schema) return;
  if (schema.type === 'object') {
    assertObject(value, label);
    for (const key of schema.required || []) {
      if (!Object.hasOwn(value, key) || value[key] === undefined) throw new ValidationError(`${label}.${key} is required`);
    }
    const properties = schema.properties || {};
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(properties, key)) throw new ValidationError(`${label}.${key} is not allowed`);
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) validateSchema(child, properties[key], `${label}.${key}`);
    }
    return;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) throw new ValidationError(`${label} must be an array`);
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      throw new ValidationError(`${label} must contain at least ${schema.minItems} item(s)`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      throw new ValidationError(`${label} must contain at most ${schema.maxItems} item(s)`);
    }
    if (schema.uniqueItems && new Set(value.map((item) => typeof item === 'string' ? item.toLowerCase() : item)).size !== value.length) {
      throw new ValidationError(`${label} must not contain duplicate items`);
    }
    if (schema.items) value.forEach((item, index) => validateSchema(item, schema.items, `${label}[${index}]`));
    return;
  }
  if (schema.type === 'string') {
    if (typeof value !== 'string') throw new ValidationError(`${label} must be a string`);
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      throw new ValidationError(`${label} must contain at least ${schema.minLength} character(s)`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      throw new ValidationError(`${label} must contain at most ${schema.maxLength} character(s)`);
    }
    if (schema.pattern && !(new RegExp(schema.pattern).test(value))) {
      throw new ValidationError(`${label} has an invalid format`);
    }
  } else if (schema.type === 'integer') {
    if (!Number.isInteger(value)) throw new ValidationError(`${label} must be an integer`);
  } else if (schema.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new ValidationError(`${label} must be finite`);
  } else if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') throw new ValidationError(`${label} must be boolean`);
  } else if (schema.type === 'null' && value !== null) {
    throw new ValidationError(`${label} must be null`);
  }
  if (schema.enum && !schema.enum.includes(value)) throw new ValidationError(`${label} has an unsupported value`);
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) throw new ValidationError(`${label} must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) throw new ValidationError(`${label} must be <= ${schema.maximum}`);
  }
}

function normalizeFeedId(value) {
  if (typeof value !== 'string') throw new ValidationError('Feed id must be a string');
  const id = value.trim().toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/.test(id)) throw new ValidationError('Feed id must contain exactly 64 hexadecimal characters');
  return id;
}

function isFeedId(value) {
  return typeof value === 'string' && /^(?:0x)?[0-9a-fA-F]{64}$/.test(value.trim());
}

function normalizeSymbol(value) {
  return String(value || '')
    .trim()
    .replace(/^crypto\./i, '')
    .replace(/\s+/g, '')
    .toUpperCase();
}

module.exports = { isObject, assertObject, validateSchema, normalizeFeedId, isFeedId, normalizeSymbol };
