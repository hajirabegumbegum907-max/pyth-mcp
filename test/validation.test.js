'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateSchema } = require('../lib/validation');
const { decimalValue } = require('../lib/client');

const closedSchema = {
  type: 'object', additionalProperties: false, required: ['feed'],
  properties: { feed: { type: 'string' } },
};

test('closed schemas reject inherited Object prototype property names', () => {
  for (const key of ['constructor', 'toString', '__proto__']) {
    const input = JSON.parse(`{"feed":"BTC/USD","${key}":{}}`);
    assert.throws(() => validateSchema(input, closedSchema, 'params'), new RegExp(`${key}.*not allowed`));
  }
});

test('required properties must be own properties', () => {
  const input = Object.create({ feed: 'BTC/USD' });
  assert.throws(() => validateSchema(input, closedSchema, 'params'), /feed.*required/);
});

test('price exponents are bounded before string allocation', () => {
  for (const exponent of [1e8, -1e8, 101, -101, 1.5]) {
    assert.throws(() => decimalValue('1', exponent, 'price'), /exponent must be an integer between -100 and 100/);
  }
  assert.equal(decimalValue('1', 100, 'price').text.length, 101);
  assert.equal(decimalValue('1', -100, 'price').text.length, 102);
});
