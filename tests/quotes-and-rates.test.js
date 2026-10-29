import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildHoldings, convertHoldings, findRate } from '../public/js/logic/calculations.js';
import { getBrokerCurrency, getCoinIds, getStockSymbols } from '../public/js/logic/catalog.js';
import { convertQuotesToMyr } from '../public/js/logic/quotes.js';

test('catalogue lists stock symbols and always asks for the USDT rate', () => {
  assert.deepEqual(getStockSymbols(), ['VOO', 'QQQM', 'SPYL.L']);
  assert.ok(getCoinIds().includes('tether'));
});

test('IBKR works in USD, Pionex in USDT, every other broker in RM', () => {
  assert.equal(getBrokerCurrency('IBKR'), 'USD');
  assert.equal(getBrokerCurrency('Pionex'), 'USDT');
  assert.equal(getBrokerCurrency('Moomoo'), 'MYR');
  assert.equal(getBrokerCurrency('Luno'), 'MYR');
  assert.equal(getBrokerCurrency('Bank'), 'MYR');
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

test('USD and USDT cash is valued at the exchange rate', () => {
  const ibkrCash = { id: 1, category: 'Cash', broker: 'IBKR', asset: 'IBKR Cash', qty: 1000, costMyr: 4100, realisedPl: 0 };
  const pionexCash = { id: 2, category: 'Cash', broker: 'Pionex', asset: 'Pionex Cash', qty: 500, costMyr: 2050, realisedPl: 0 };
  const [ibkr, pionex] = buildHoldings([ibkrCash, pionexCash], { 'fx:USD': 4.2, 'fx:USDT': 4.1 });
  assert.equal(ibkr.marketValue, 4200);
  assert.equal(ibkr.unrealisedPl, 100);
  assert.equal(pionex.marketValue, 2050);
});

test('convertHoldings changes money fields but not quantities or percentages', () => {
  const holdings = buildHoldings(
    [{ id: 1, category: 'Crypto', broker: 'Luno', asset: 'BTC', qty: 2, costMyr: 200000, realisedPl: 400 }],
    { bitcoin: 120000 },
  );
  const [usd] = convertHoldings(holdings, 4);
  assert.equal(usd.marketValue, 60000);
  assert.equal(usd.costMyr, 50000);
  assert.equal(usd.unrealisedPl, 10000);
  assert.equal(usd.realisedPl, 100);
  assert.equal(usd.unitPrice, 30000);
  assert.equal(usd.qty, 2);
  assert.equal(usd.unrealisedPlPct, holdings[0].unrealisedPlPct);
});
