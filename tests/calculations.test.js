import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildCsv } from '../public/js/logic/export-csv.js';
import { formatRm, formatSignedRm } from '../public/js/logic/format.js';
import {
  applyTransaction,
  buildHoldings,
  groupTotals,
  resolveUnitPrice,
  summarise,
} from '../public/js/logic/calculations.js';

const btc = { id: 1, category: 'Crypto', broker: 'Luno', asset: 'BTC', qty: 2, costMyr: 200000, realisedPl: 0 };

test('resolveUnitPrice uses the fixed price for cash assets', () => {
  const cash = { ...btc, asset: 'Bank Cash', qty: 500, costMyr: 500 };
  assert.deepEqual(resolveUnitPrice(cash, {}), { price: 1, source: 'fixed' });
});

test('resolveUnitPrice uses the market price when it is valid', () => {
  assert.deepEqual(resolveUnitPrice(btc, { bitcoin: 120000 }), { price: 120000, source: 'market' });
});

test('resolveUnitPrice falls back to average cost, never to zero', () => {
  assert.deepEqual(resolveUnitPrice(btc, {}), { price: 100000, source: 'cost' });
  assert.deepEqual(resolveUnitPrice(btc, { bitcoin: 0 }), { price: 100000, source: 'cost' });
  assert.deepEqual(resolveUnitPrice(btc, { bitcoin: NaN }), { price: 100000, source: 'cost' });
});

test('buildHoldings and summarise calculate value and profit', () => {
  const holdings = buildHoldings([btc], { bitcoin: 120000 });
  const summary = summarise(holdings);
  assert.equal(summary.marketValue, 240000);
  assert.equal(summary.costMyr, 200000);
  assert.equal(summary.unrealisedPl, 40000);
  assert.equal(summary.unrealisedPlPct, 20);
});

test('groupTotals adds holdings that share a key', () => {
  const second = { ...btc, id: 2, broker: 'Pionex', qty: 1, costMyr: 90000 };
  const groups = groupTotals(buildHoldings([btc, second], { bitcoin: 100000 }), (h) => h.asset);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].marketValue, 300000);
  assert.equal(groups[0].costMyr, 290000);
});

test('buy updates the weighted-average cost', () => {
  const { updatedPosition } = applyTransaction(btc, { action: 'buy', qty: 2, unitPrice: 120000 });
  assert.equal(updatedPosition.qty, 4);
  assert.equal(updatedPosition.costMyr, 440000);
  assert.equal(updatedPosition.realisedPl, 0);
});

test('sell removes cost at the average and records realised profit', () => {
  const { updatedPosition, realisedChange } = applyTransaction(btc, { action: 'sell', qty: 1, unitPrice: 130000 });
  assert.equal(updatedPosition.qty, 1);
  assert.equal(updatedPosition.costMyr, 100000);
  assert.equal(realisedChange, 30000);
  assert.equal(updatedPosition.realisedPl, 30000);
});

test('selling everything closes the position cleanly', () => {
  const { updatedPosition } = applyTransaction(btc, { action: 'sell', qty: 2, unitPrice: 90000 });
  assert.equal(updatedPosition.qty, 0);
  assert.equal(updatedPosition.costMyr, 0);
  assert.equal(updatedPosition.realisedPl, -20000);
});

test('withdrawing cash does not create profit', () => {
  const cash = { ...btc, asset: 'Bank Cash', broker: 'Bank', category: 'Cash', qty: 1000, costMyr: 1000 };
  const { updatedPosition } = applyTransaction(cash, { action: 'sell', qty: 250, unitPrice: 1 });
  assert.equal(updatedPosition.qty, 750);
  assert.equal(updatedPosition.costMyr, 750);
  assert.equal(updatedPosition.realisedPl, 0);
});

test('invalid transactions are rejected', () => {
  assert.throws(() => applyTransaction(btc, { action: 'sell', qty: 3, unitPrice: 1 }), /more than you hold/);
  assert.throws(() => applyTransaction(btc, { action: 'buy', qty: 0, unitPrice: 1 }), /greater than zero/);
  assert.throws(() => applyTransaction(btc, { action: 'buy', qty: 1, unitPrice: -1 }), /zero or more/);
  assert.throws(() => applyTransaction(btc, { action: 'hold', qty: 1, unitPrice: 1 }), /buy or sell/);
});

test('money formatting handles signs and negative zero', () => {
  assert.equal(formatRm(1234.5), 'RM 1,234.50');
  assert.equal(formatRm(-12), '-RM 12.00');
  assert.equal(formatRm(-0.001), 'RM 0.00');
  assert.equal(formatSignedRm(5), '+RM 5.00');
});

test('csv export escapes commas, quotes and formulas', () => {
  const holding = {
    ...buildHoldings([{ ...btc, asset: '=SUM(A1)', broker: 'Lu,no' }], {})[0],
  };
  const csv = buildCsv([holding]);
  assert.match(csv, /"'=SUM\(A1\)"|'=SUM\(A1\)/);
  assert.match(csv, /"Lu,no"/);
});
