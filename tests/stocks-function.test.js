import assert from 'node:assert/strict';
import { test } from 'node:test';

import { getStockQuotes, onRequestGet } from '../functions/api/stocks.js';

function yahooAnswer(price, currency) {
  return { ok: true, json: async () => ({ chart: { result: [{ meta: { regularMarketPrice: price, currency } }] } }) };
}

// A fake network: the handler receives the URL and returns an answer or throws.
function createFetch(handler) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    return handler(String(url));
  };
  return { fetchImpl, calls };
}

test('quotes and exchange rates come from Yahoo Finance', async () => {
  const { fetchImpl } = createFetch((url) => {
    if (url.includes('/VOO')) return yahooAnswer(600, 'USD');
    if (url.includes('USDMYR=X')) return yahooAnswer(4.2, 'MYR');
    throw new Error('unexpected ' + url);
  });
  const result = await getStockQuotes(['VOO'], { fetchImpl });
  assert.deepEqual(result.quotes.VOO, { price: 600, currency: 'USD', source: 'yahoo' });
  assert.equal(result.fx.USD, 4.2);
  assert.deepEqual(result.errors, {});
});

test('London prices in pence are converted to pounds and get a GBP rate', async () => {
  const { fetchImpl } = createFetch((url) => {
    if (url.includes('/SPYL.L')) return yahooAnswer(5000, 'GBp');
    if (url.includes('GBPMYR=X')) return yahooAnswer(5.6, 'MYR');
    if (url.includes('USDMYR=X')) return yahooAnswer(4.2, 'MYR');
    throw new Error('unexpected ' + url);
  });
  const result = await getStockQuotes(['SPYL.L'], { fetchImpl });
  assert.deepEqual(result.quotes['SPYL.L'], { price: 50, currency: 'GBP', source: 'yahoo' });
  assert.equal(result.fx.GBP, 5.6);
});

test('Finnhub is the backup for US stocks when Yahoo fails', async () => {
  const { fetchImpl, calls } = createFetch((url) => {
    if (url.includes('finnhub.io')) return { ok: true, json: async () => ({ c: 601.5 }) };
    if (url.includes('USDMYR=X')) return yahooAnswer(4.2, 'MYR');
    return { ok: false, status: 429 };
  });
  const result = await getStockQuotes(['VOO'], { fetchImpl, finnhubToken: 'secret' });
  assert.deepEqual(result.quotes.VOO, { price: 601.5, currency: 'USD', source: 'finnhub' });
  assert.ok(calls.some((url) => url.includes('token=secret')));
});

test('a failing symbol is reported without breaking the others', async () => {
  const { fetchImpl } = createFetch((url) => {
    if (url.includes('/QQQM')) return { ok: false, status: 500 };
    if (url.includes('/VOO')) return yahooAnswer(600, 'USD');
    return yahooAnswer(4.2, 'MYR');
  });
  const result = await getStockQuotes(['VOO', 'QQQM'], { fetchImpl });
  assert.ok(result.quotes.VOO);
  assert.equal(result.quotes.QQQM, undefined);
  assert.match(result.errors.QQQM, /Yahoo Finance/);
});

test('the endpoint rejects missing, invalid and too many symbols', async () => {
  const ask = (query) => onRequestGet({ request: new Request(`https://example.com/api/stocks${query}`), env: {} });
  assert.equal((await ask('')).status, 400);
  assert.equal((await ask('?symbols=VOO;DROP')).status, 400);
  assert.equal((await ask('?symbols=A,B,C,D,E,F,G,H,I,J,K')).status, 400);
});
