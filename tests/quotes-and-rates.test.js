import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyTransaction, buildHoldings, findRate } from '../public/js/logic/calculations.js';
import { getCoinIds, getEntryCurrency, getStockSymbols } from '../public/js/logic/catalog.js';
import { convertQuotesToMyr } from '../public/js/logic/quotes.js';

test('catalogue lists stock symbols and always asks for the USDT rate', () => {
  assert.deepEqual(getStockSymbols(), ['VOO', 'QQQM', 'SPYL.L']);
  assert.ok(getCoinIds().includes('tether'));
});

test('IBKR stocks use USD and Pionex crypto uses USDT; everything else uses RM', () => {
  assert.equal(getEntryCurrency('IBKR', 'VOO'), 'USD');
  assert.equal(getEntryCurrency('Pionex', 'BTC'), 'USDT');
  assert.equal(getEntryCurrency('Moomoo', 'VOO'), null);
  assert.equal(getEntryCurrency('Luno', 'BTC'), null);
  assert.equal(getEntryCurrency('Bank', 'Bank Cash'), null);
});

test('convertQuotesToMyr multiplies each price by its currency rate', () => {
  const prices = convertQuotesToMyr({
    quotes: { VOO: { price: 600, currency: 'USD' }, 'SPYL.L': { price: 50, currency: 'GBP' } },
    fx: { USD: 4, GBP: 5.5 },
  });
  assert.deepEqual(prices, { VOO: 2400, 'SPYL.L': 275, 'fx:USD': 4 });
});

test('convertQuotesToMyr skips bad data and uses the fallback USD rate only when needed', () => {
  const payload = { quotes: { VOO: { price: 600, currency: 'USD' }, QQQM: { price: 0, currency: 'USD' } }, fx: {} };
  assert.deepEqual(convertQuotesToMyr(payload, 4.2), { VOO: 2520 });
  assert.deepEqual(convertQuotesToMyr(payload), {});
  assert.deepEqual(convertQuotesToMyr(null), {});
});

test('findRate prefers the direct rate and lets USD and USDT stand in for each other', () => {
  assert.equal(findRate({ 'fx:USD': 4.2, 'fx:USDT': 4.1 }, 'USD'), 4.2);
  assert.equal(findRate({ 'fx:USDT': 4.1 }, 'USD'), 4.1);
  assert.equal(findRate({ 'fx:USD': 4.2 }, 'USDT'), 4.2);
  assert.equal(findRate({}, 'USD'), null);
  assert.equal(findRate({ 'fx:USD': 0 }, 'USD'), null);
});

test('stock holdings are priced from the stock symbol', () => {
  const voo = { id: 1, category: 'Stocks', broker: 'IBKR', asset: 'VOO', qty: 2, costMyr: 4000, realisedPl: 0 };
  const [holding] = buildHoldings([voo], { VOO: 2400 });
  assert.equal(holding.marketValue, 4800);
  assert.equal(holding.priceSource, 'market');
});

test('a USD purchase is saved in RM at the rate of the day', () => {
  const rate = 4.2;
  const usdPrice = 600;
  const empty = { id: null, category: 'Stocks', broker: 'IBKR', asset: 'VOO', qty: 0, costMyr: 0, realisedPl: 0 };
  const { updatedPosition } = applyTransaction(empty, { action: 'buy', qty: 2, unitPrice: usdPrice * rate });
  assert.equal(updatedPosition.costMyr, 5040);

  const sale = applyTransaction(updatedPosition, { action: 'sell', qty: 1, unitPrice: 650 * rate });
  assert.equal(sale.realisedChange, 210); // (650 - 600) USD x 4.2
});
