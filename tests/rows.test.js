import assert from 'node:assert/strict';
import { test } from 'node:test';

import { toDatabaseRow, toPosition, toTransaction, toTransactionRow } from '../public/js/logic/rows.js';

test('position: database row and app object convert both ways', () => {
  const row = { id: 3, category: 'Crypto', broker: 'Luno', asset: 'BTC', qty: '0.5', cost_myr: '100000.5', realised_pl: null };
  const position = toPosition(row);
  assert.deepEqual(position, { id: 3, category: 'Crypto', broker: 'Luno', asset: 'BTC', qty: 0.5, costMyr: 100000.5, realisedPl: 0 });
  assert.deepEqual(toDatabaseRow(position), { category: 'Crypto', broker: 'Luno', asset: 'BTC', qty: 0.5, cost_myr: 100000.5, realised_pl: 0 });
});

test('transaction: the broker trade id is kept, and an ordinary entry stores null (so the unique index ignores it)', () => {
  const record = { tradeDate: '2026-10-01', kind: 'buy', broker: 'Luno', asset: 'BTC', qty: 1, price: 2, currency: 'MYR', fee: 0, rate: 1, totalMyr: 2, fromAccount: '', toAccount: '', amountFrom: 2, amountTo: 1, realisedPl: 0, note: '' };
  assert.equal(toTransactionRow({ ...record, externalId: 'luno:XBTMYR:9' }).external_id, 'luno:XBTMYR:9');
  assert.equal(toTransactionRow({ ...record, externalId: '' }).external_id, null);
  assert.equal(toTransaction({ id: 1, trade_date: '2026-10-01', kind: 'buy', external_id: 'x:1' }).externalId, 'x:1');
  assert.equal(toTransaction({ id: 1, trade_date: '2026-10-01', kind: 'buy', external_id: null }).externalId, '');
});
