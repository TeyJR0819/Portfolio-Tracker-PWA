import assert from 'node:assert/strict';
import { test } from 'node:test';

import { aggregateCandles, convertCandles, getCandles, handleCandlesRequest, searchAssets } from '../src/candles.js';

function yahooBody(times, closes, currency = 'USD') {
  return {
    chart: {
      result: [
        {
          meta: { currency, longName: 'Test Asset' },
          timestamp: times,
          indicators: { quote: [{ open: closes, high: closes.map((c) => c + 1), low: closes.map((c) => c - 1), close: closes, volume: closes.map(() => 10) }] },
        },
      ],
    },
  };
}

function createFetch(handler) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    const body = await handler(String(url));
    return body === null ? { ok: false, status: 500 } : { ok: true, json: async () => body };
  };
  return { fetchImpl, calls };
}

test('hourly candles are joined into 4-hour candles', () => {
  const hour = 3600;
  const base = 4 * hour * 100;
  const candles = [0, 1, 2, 3, 4].map((i) => ({ time: base + i * hour, open: 10 + i, high: 20 + i, low: i, close: 11 + i, volume: 1 }));
  const joined = aggregateCandles(candles, 4 * hour);
  assert.equal(joined.length, 2);
  assert.deepEqual(joined[0], { time: base, open: 10, high: 23, low: 0, close: 14, volume: 4 });
  assert.equal(joined[1].time, base + 4 * hour);
});

test('each candle uses the exchange rate that applied at its time', () => {
  const candles = [
    { time: 100, open: 1, high: 2, low: 1, close: 2, volume: 0 },
    { time: 200, open: 1, high: 2, low: 1, close: 2, volume: 0 },
  ];
  const result = convertCandles(candles, [{ time: 50, close: 4 }, { time: 150, close: 5 }]);
  assert.equal(result[0].close, 8);
  assert.equal(result[1].close, 10);
  assert.equal(convertCandles(candles, []), null);
});

test('stock candles are converted to MYR with the exchange rate history', async () => {
  const { fetchImpl, calls } = createFetch((url) => {
    if (url.includes('/VOO?')) return yahooBody([100, 200], [10, 20]);
    if (url.includes('USDMYR=X')) return yahooBody([100, 200], [4, 5], 'MYR');
    throw new Error(`unexpected ${url}`);
  });
  const result = await getCandles({ symbol: 'VOO', interval: '1D', currency: 'MYR' }, { fetchImpl });
  assert.equal(result.currency, 'MYR');
  assert.equal(result.nativeCurrency, 'USD');
  assert.equal(result.candles[0].close, 40);
  assert.equal(result.candles[1].close, 100);
  assert.ok(calls[0].includes('interval=1d'));
});

test('USD candles need no conversion', async () => {
  const { fetchImpl, calls } = createFetch(() => yahooBody([100], [10]));
  const result = await getCandles({ symbol: 'VOO', interval: '1h', currency: 'USD' }, { fetchImpl });
  assert.equal(calls.length, 1);
  assert.equal(result.candles[0].close, 10);
  assert.ok(calls[0].includes('interval=60m'));
});

test('4-hour candles are built from hourly candles and hourly rates', async () => {
  const hour = 3600;
  const base = 4 * hour * 100;
  const times = [0, 1, 2, 3].map((i) => base + i * hour);
  const { fetchImpl, calls } = createFetch((url) => {
    if (url.includes('BTC-USD')) return yahooBody(times, [10, 11, 12, 13]);
    return yahooBody(times, [2, 2, 2, 2], 'MYR');
  });
  const result = await getCandles({ symbol: 'BTC-USD', interval: '4h', currency: 'MYR' }, { fetchImpl });
  assert.equal(result.candles.length, 1);
  assert.equal(result.candles[0].close, 26);
  assert.ok(calls.every((url) => url.includes('interval=60m')));
});

test('prices stay in the original currency when the rate is missing, with a note', async () => {
  const { fetchImpl } = createFetch((url) => (url.includes('USDMYR') ? null : yahooBody([100], [10])));
  const result = await getCandles({ symbol: 'VOO', interval: '1D', currency: 'MYR' }, { fetchImpl });
  assert.equal(result.currency, 'USD');
  assert.match(result.note, /MYR exchange rate/);
});

test('London prices in pence are shown in pounds', async () => {
  const { fetchImpl } = createFetch((url) => (url.includes('GBPUSD') ? yahooBody([100], [1.25], 'USD') : yahooBody([100], [5000], 'GBp')));
  const result = await getCandles({ symbol: 'VUSA.L', interval: '1D', currency: 'USD' }, { fetchImpl });
  assert.equal(result.nativeCurrency, 'GBP');
  assert.equal(result.candles[0].close, 62.5);
});

test('CoinGecko is the backup when Yahoo has no candles for a coin', async () => {
  const hour = 3600;
  const start = 4 * hour * 100 * 1000;
  const rows = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => [start + i * 1800 * 1000, 1 + i, 2 + i, 0.5 + i, 1.5 + i]);
  const { fetchImpl, calls } = createFetch((url) => (url.includes('coingecko') ? rows : null));
  const result = await getCandles({ symbol: 'SUI20947-USD', coin: 'sui', interval: '1h', currency: 'MYR' }, { fetchImpl });
  assert.equal(result.source, 'coingecko');
  assert.equal(result.currency, 'MYR');
  assert.equal(result.candles.length, 4); // 30-minute candles joined into hours
  assert.ok(calls.some((url) => url.includes('vs_currency=myr')));
  assert.equal(result.note, '');
});

test('CoinGecko candles larger than asked are returned with a note', async () => {
  const rows = [0, 1, 2].map((i) => [i * 4 * 3600 * 1000, 1, 2, 1, 2]);
  const { fetchImpl } = createFetch((url) => (url.includes('coingecko') ? rows : null));
  const result = await getCandles({ coin: 'sui', interval: '5m', currency: 'USD' }, { fetchImpl });
  assert.match(result.note, /4-hour candles at best/);
});

test('an unknown interval or a total failure is an error', async () => {
  await assert.rejects(getCandles({ symbol: 'VOO', interval: '3m', currency: 'USD' }, { fetchImpl: async () => ({ ok: false, status: 500 }) }), /Unknown interval/);
  const { fetchImpl } = createFetch(() => null);
  await assert.rejects(getCandles({ symbol: 'VOO', coin: 'x', interval: '1D', currency: 'USD' }, { fetchImpl }), /Yahoo Finance.*CoinGecko/);
});

test('search merges Yahoo and CoinGecko, and keeps one entry for a coin both know', async () => {
  const { fetchImpl } = createFetch((url) => {
    if (url.includes('finance/search')) {
      return {
        quotes: [
          { symbol: 'BTC-USD', quoteType: 'CRYPTOCURRENCY', shortname: 'Bitcoin USD', exchDisp: 'CCC' },
          { symbol: 'MSTR', quoteType: 'EQUITY', longname: 'Strategy Inc', exchDisp: 'NASDAQ' },
          { symbol: 'NEWS', quoteType: 'OPTION' },
        ],
      };
    }
    return { coins: [{ id: 'bitcoin', name: 'Bitcoin', symbol: 'btc', market_cap_rank: 1 }, { id: 'bitcoin-cash', name: 'Bitcoin Cash', symbol: 'bch', market_cap_rank: 20 }] };
  });
  const results = await searchAssets('bitcoin', { fetchImpl });
  assert.equal(results.find((item) => item.symbol === 'BTC-USD').coin, 'bitcoin');
  assert.equal(results.filter((item) => item.coin === 'bitcoin').length, 1);
  assert.ok(results.some((item) => item.coin === 'bitcoin-cash' && item.symbol === ''));
  assert.ok(results.some((item) => item.symbol === 'MSTR' && item.type === 'Stock'));
  assert.ok(!results.some((item) => item.symbol === 'NEWS'));
});

test('search still works when one service fails, and fails when both do', async () => {
  const onlyYahoo = createFetch((url) => (url.includes('coingecko') ? null : { quotes: [{ symbol: 'VOO', quoteType: 'ETF', shortname: 'Vanguard S&P 500' }] }));
  assert.equal((await searchAssets('voo', { fetchImpl: onlyYahoo.fetchImpl })).length, 1);
  await assert.rejects(searchAssets('voo', { fetchImpl: createFetch(() => null).fetchImpl }), /unreachable/);
});

test('the candles handler rejects bad input before any request is made', async () => {
  for (const query of ['', 'symbol=VOO&interval=9x', 'symbol=VOO&currency=EUR', 'symbol=bad%20symbol!', 'coin=Bad_Coin']) {
    const response = await handleCandlesRequest({ request: new Request(`https://example.com/api/candles?${query}`), env: {} });
    assert.equal(response.status, 400, query);
  }
});
