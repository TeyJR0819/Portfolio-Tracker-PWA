import assert from 'node:assert/strict';
import { test } from 'node:test';

import { findNewTrades, importTrades, toTradeDate, tradeToEntry } from '../public/js/logic/trade-import.js';

const RATES = { 'fx:USD': 4, 'fx:USDT': 4.1 };
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-10-01T04:00:00Z');

function trade(id, overrides = {}) {
  return { externalId: id, broker: 'Luno', asset: 'BTC', side: 'buy', qty: 0.01, cashAmount: 3000, feeQuote: 0, quoteCurrency: 'MYR', tradedAt: T0, ...overrides };
}

// A stand-in for saveEntry: gives new rows an id, like the database does.
function createFakeSave() {
  let nextId = 100;
  const saved = [];
  return {
    saved,
    save: async ({ changes, record }) => {
      const positions = changes.map(({ after }) => ({ ...after, id: after.id ?? nextId++ }));
      saved.push(record);
      return { positions, transaction: { ...record, id: saved.length }, logError: '' };
    },
  };
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

test('import: builds the holding from an empty ledger, costs include fees, and each line carries its trade id', async () => {
  const { save, saved } = createFakeSave();
  const result = await importTrades({
    trades: [trade('1', { qty: 0.01, cashAmount: 3004.5, feeQuote: 4.5 }), trade('2', { qty: 0.01, cashAmount: 3100, tradedAt: T0 + DAY })],
    positions: [], marketPrices: RATES, useCash: false, save,
  });
  assert.equal(result.message, '');
  assert.deepEqual(result.importedIds, ['1', '2']);
  const btc = result.positions.find((p) => p.asset === 'BTC');
  assert.equal(btc.qty, 0.02);
  assert.equal(btc.costMyr, 6104.5);
  assert.deepEqual(saved.map((record) => record.externalId), ['1', '2']);
  assert.equal(saved[0].note, 'Imported from Luno');
});

test('import: a sale realises profit against the average cost', async () => {
  const { save } = createFakeSave();
  const result = await importTrades({
    trades: [trade('1', { qty: 0.02, cashAmount: 6000 }), trade('2', { side: 'sell', qty: 0.01, cashAmount: 3500, tradedAt: T0 + DAY })],
    positions: [], marketPrices: RATES, useCash: false, save,
  });
  const btc = result.positions.find((p) => p.asset === 'BTC');
  assert.equal(btc.qty, 0.01);
  assert.equal(btc.realisedPl, 500);
});

test('import: Pionex trades are converted from USDT at the current rate', async () => {
  const { save } = createFakeSave();
  const result = await importTrades({
    trades: [trade('p1', { broker: 'Pionex', qty: 0.001, cashAmount: 100, quoteCurrency: 'USDT' })],
    positions: [], marketPrices: RATES, useCash: false, save,
  });
  assert.equal(result.positions.find((p) => p.asset === 'BTC').costMyr, 410);
});

test('import: with the cash option on, the broker cash moves too', async () => {
  const { save } = createFakeSave();
  const cash = { id: 1, category: 'Cash', broker: 'Luno', asset: 'Luno Cash', qty: 5000, costMyr: 5000, realisedPl: 0 };
  const result = await importTrades({ trades: [trade('1', { cashAmount: 3000 })], positions: [cash], marketPrices: RATES, useCash: true, save });
  assert.equal(result.positions.find((p) => p.asset === 'Luno Cash').qty, 2000);
});

test('import: stops at a sale the ledger cannot cover and keeps the earlier trades', async () => {
  const { save, saved } = createFakeSave();
  const result = await importTrades({
    trades: [trade('1', { qty: 0.01 }), trade('2', { side: 'sell', qty: 0.5, tradedAt: T0 + DAY }), trade('3', { tradedAt: T0 + 2 * DAY })],
    positions: [], marketPrices: RATES, useCash: false, save,
  });
  assert.deepEqual(result.importedIds, ['1']);
  assert.equal(saved.length, 1, 'the third trade is not recorded on top of the missing second one');
  assert.match(result.message, /Stopped at the Luno sell of 0.5 BTC on 2026-10-02/);
  assert.match(result.message, /1 trade was recorded before it/);
});

test('import: a failed save stops the import and says why', async () => {
  const result = await importTrades({
    trades: [trade('1')], positions: [], marketPrices: RATES, useCash: false,
    save: async () => { throw new Error('Could not save. Nothing was changed.'); },
  });
  assert.deepEqual(result.importedIds, []);
  assert.match(result.message, /Could not save/);
});

test('import: a history line that did not save is reported so the trade is not imported twice by mistake', async () => {
  const result = await importTrades({
    trades: [trade('1'), trade('2', { tradedAt: T0 + DAY })], positions: [], marketPrices: RATES, useCash: false,
    save: async ({ changes }) => ({ positions: changes.map(({ after }) => ({ ...after, id: 1 })), transaction: null, logError: 'history failed' }),
  });
  assert.match(result.message, /history line was not/);
  assert.deepEqual(result.importedIds, ['1']);
});

test('import: a missing exchange rate is reported instead of guessing', async () => {
  const { save } = createFakeSave();
  const result = await importTrades({ trades: [trade('p1', { broker: 'Pionex', quoteCurrency: 'USDT' })], positions: [], marketPrices: {}, useCash: false, save });
  assert.match(result.message, /rate is not available/);
});
