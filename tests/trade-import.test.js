import assert from 'node:assert/strict';
import { test } from 'node:test';

import { findNewTrades, planTradeImport, toTradeDate, tradeToEntry } from '../src/trade-import.js';

const RATES = { 'fx:USD': 4, 'fx:USDT': 4.1 };
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-10-01T04:00:00Z');

function trade(id, overrides = {}) {
  return { externalId: id, broker: 'Luno', asset: 'BTC', side: 'buy', qty: 0.01, cashAmount: 3000, feeQuote: 0, quoteCurrency: 'MYR', tradedAt: T0, ...overrides };
}

test('trade date uses the Malaysian calendar day', () => {
  assert.equal(toTradeDate(Date.parse('2026-10-01T17:00:00Z')), '2026-10-02');
});

test('new trades: skips imported, untracked and earlier-than-date trades, oldest first', () => {
  const trades = [
    trade('c', { tradedAt: T0 + 2 * DAY }),
    trade('a', { tradedAt: T0 }),
    trade('b', { tradedAt: T0 + DAY }),
    trade('x', { asset: 'DOGE' }),
    trade('y', { broker: 'Pionex' }), // Pionex can hold BTC, so this one is tracked
    trade('z', { broker: 'IBKR' }), // IBKR does not trade crypto
  ];
  const all = findNewTrades({ trades, importedIds: ['b'] });
  assert.deepEqual(all.map((t) => t.externalId), ['a', 'y', 'c']);
  const since = findNewTrades({ trades, importedIds: [], sinceDate: '2026-10-02' });
  assert.deepEqual(since.map((t) => t.externalId), ['b', 'c']);
});

test('entry: carries the total, fee, date, note and the broker trade id', () => {
  const entry = tradeToEntry(trade('luno:1', { feeQuote: 4.5, cashAmount: 3004.5 }), { useCash: false });
  assert.deepEqual(
    { kind: entry.kind, entryMode: entry.entryMode, total: entry.total, fee: entry.fee, useCash: entry.useCash, tradeDate: entry.tradeDate, externalId: entry.externalId },
    { kind: 'buy', entryMode: 'total', total: 3004.5, fee: 4.5, useCash: false, tradeDate: '2026-10-01', externalId: 'luno:1' },
  );
});

test('plan: builds the holding from an empty ledger, costs include fees, and each line carries its trade id', () => {
  const result = planTradeImport({
    trades: [trade('1', { qty: 0.01, cashAmount: 3004.5, feeQuote: 4.5 }), trade('2', { qty: 0.01, cashAmount: 3100, tradedAt: T0 + DAY })],
    positions: [], marketPrices: RATES,
  });
  assert.equal(result.message, '');
  assert.deepEqual(result.importedIds, ['1', '2']);
  const btc = result.positions.find((p) => p.asset === 'BTC');
  assert.equal(btc.qty, 0.02);
  assert.equal(btc.costMyr, 6104.5);
  assert.deepEqual(result.records.map((record) => record.externalId), ['1', '2']);
  assert.equal(result.records[0].note, 'Imported from Luno');
});

test('plan: a sale realises profit against the average cost', () => {
  const result = planTradeImport({
    trades: [trade('1', { qty: 0.02, cashAmount: 6000 }), trade('2', { side: 'sell', qty: 0.01, cashAmount: 3500, tradedAt: T0 + DAY })],
    positions: [], marketPrices: RATES,
  });
  const btc = result.positions.find((p) => p.asset === 'BTC');
  assert.equal(btc.qty, 0.01);
  assert.equal(btc.realisedPl, 500);
});

test('plan: Pionex trades are converted from USDT at the given rate', () => {
  const result = planTradeImport({ trades: [trade('p1', { broker: 'Pionex', qty: 0.001, cashAmount: 100, quoteCurrency: 'USDT' })], positions: [], marketPrices: RATES });
  assert.equal(result.positions.find((p) => p.asset === 'BTC').costMyr, 410);
});

test('plan: with the cash option on, the broker cash moves too', () => {
  const cash = { id: 1, category: 'Cash', broker: 'Luno', asset: 'Luno Cash', qty: 5000, costMyr: 5000, realisedPl: 0 };
  const result = planTradeImport({ trades: [trade('1', { cashAmount: 3000 })], positions: [cash], marketPrices: RATES, useCash: true });
  assert.equal(result.positions.find((p) => p.asset === 'Luno Cash').qty, 2000);
});

test('plan: a sale of coins the ledger never bought is covered by an opening balance at the sale price', () => {
  const result = planTradeImport({ trades: [trade('1', { side: 'sell', qty: 0.5, cashAmount: 1000 }), trade('2', { qty: 0.01, tradedAt: T0 + DAY })], positions: [], marketPrices: RATES });
  assert.equal(result.message, '');
  assert.deepEqual(result.importedIds, ['1', '2']);
  assert.equal(result.openingCount, 1);
  assert.equal(result.records.length, 3, 'opening line, the sale, then the later buy');
  assert.match(result.records[0].note, /Opening balance/);
  const btc = result.positions.find((p) => p.asset === 'BTC');
  assert.equal(btc.qty, 0.01);
  assert.equal(btc.realisedPl, 0);
});

test('plan: a partly covered sale adds only the missing coins', () => {
  const result = planTradeImport({
    trades: [trade('1', { qty: 0.1, cashAmount: 300 }), trade('2', { side: 'sell', qty: 0.3, cashAmount: 900, tradedAt: T0 + DAY })],
    positions: [], marketPrices: RATES,
  });
  assert.equal(result.records[1].qty, 0.2, 'opening line for the 0.2 that was never bought');
  assert.equal(result.positions.find((p) => p.asset === 'BTC').qty, 0);
});

test('plan: a problem holds back only the same coin at the same broker', () => {
  const result = planTradeImport({
    trades: [trade('p1', { broker: 'Pionex', quoteCurrency: 'USDT' }), trade('p2', { broker: 'Pionex', quoteCurrency: 'USDT', tradedAt: T0 + DAY }), trade('l1', { asset: 'ETH', tradedAt: T0 + 2 * DAY })],
    positions: [], marketPrices: {},
  });
  assert.deepEqual(result.importedIds, ['l1']);
  assert.match(result.message, /Held back the Pionex buy/);
});

test('plan: a missing exchange rate is reported instead of guessing', () => {
  const result = planTradeImport({ trades: [trade('p1', { broker: 'Pionex', quoteCurrency: 'USDT' })], positions: [], marketPrices: {} });
  assert.match(result.message, /rate is not available/);
  assert.deepEqual(result.importedIds, []);
});

test('plan: transfer_to_pionex deducts from Luno and adds to Pionex with proportional cost basis', () => {
  const lunoAda = { id: 1, category: 'Crypto', broker: 'Luno', asset: 'ADA', qty: 2414.88934, costMyr: 4829.78, realisedPl: 0 };
  const transfer = trade('t1', {
    asset: 'ADA',
    side: 'transfer_to_pionex',
    qty: 1008.2163699,
    cashAmount: 0,
    quoteCurrency: 'MYR',
  });
  const result = planTradeImport({ trades: [transfer], positions: [lunoAda], marketPrices: { cardano: 2.0 } });
  assert.equal(result.message, '');
  assert.deepEqual(result.importedIds, ['t1']);

  const newLuno = result.positions.find((p) => p.broker === 'Luno' && p.asset === 'ADA');
  const newPionex = result.positions.find((p) => p.broker === 'Pionex' && p.asset === 'ADA');

  assert.equal(newLuno.qty, Number((2414.88934 - 1008.2163699).toFixed(8)));
  assert.equal(newPionex.qty, 1008.2163699);
  assert.equal(newPionex.costMyr, 2016.43);
  assert.equal(newLuno.costMyr, Number((4829.78 - 2016.43).toFixed(2)));
  assert.equal(newLuno.realisedPl, 0);
  assert.equal(newPionex.realisedPl, 0);

  const record = result.records[0];
  assert.equal(record.kind, 'transfer');
  assert.equal(record.note, 'Transferred 1008.2163699 ADA from Luno to Pionex');
  assert.equal(record.fromAccount, 'Luno ADA');
  assert.equal(record.toAccount, 'Pionex ADA');
});

test('plan: an inflow with cashAmount 0 uses market price for cost basis', () => {
  const inflow = trade('in1', {
    asset: 'BTC',
    side: 'buy',
    qty: 0.00380077,
    cashAmount: 0,
    quoteCurrency: 'MYR',
  });
  const result = planTradeImport({ trades: [inflow], positions: [], marketPrices: { bitcoin: 300000 } });
  assert.equal(result.message, '');
  assert.deepEqual(result.importedIds, ['in1']);
  const btc = result.positions.find((p) => p.broker === 'Luno' && p.asset === 'BTC');
  assert.equal(btc.qty, 0.00380077);
  assert.equal(btc.costMyr, Math.round(0.00380077 * 300000 * 100) / 100);
});
