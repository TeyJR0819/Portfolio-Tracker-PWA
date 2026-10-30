import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fetchIbkrBalances, parseFlexReport } from '../src/brokers/ibkr.js';
import { fetchLunoBalances, fetchLunoTrades } from '../src/brokers/luno.js';
import { fetchPionexBalances, fetchPionexTrades, sign } from '../src/brokers/pionex.js';
import { runBrokerSync } from '../src/brokers/sync.js';
import { toTradeRow } from '../src/brokers/trades.js';
import { MATCH_STATES, reconcileBalances } from '../public/js/logic/reconcile.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

test('Pionex signature matches the documented example', async () => {
  const secret = 'NFqv4MB3hB0SOiEsJNDP9e0jDdKPWbDqS_Z1dbU4';
  const message = 'GET/api/v1/trade/allOrders?limit=1&symbol=BTC_USDT&timestamp=1655896754515{"symbol": "BTC_USDT"}';
  assert.equal(await sign(secret, message), 'ec83d21e1237cbe7e0172f79c0e3a4741c86f6b201ba762f21149bf195519be1');
});

test('Luno: basic auth, XBT renamed, MYR becomes Luno Cash, zero balances dropped', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return json({ balance: [
      { asset: 'XBT', balance: '0.50000000' }, { asset: 'MYR', balance: '0.11' },
      { asset: 'ETH', balance: '0.00' }, { asset: 'XBT', balance: '0.1', account_id: 'second' },
    ] });
  };
  const rows = await fetchLunoBalances({ keyId: 'id', keySecret: 'secret', fetchImpl });
  assert.equal(seen.url, 'https://api.luno.com/api/1/balance');
  assert.equal(seen.init.headers.Authorization, `Basic ${btoa('id:secret')}`);
  assert.deepEqual(rows, [{ asset: 'BTC', qty: 0.6 }, { asset: 'Luno Cash', qty: 0.11 }]);
});

test('Luno: an error status throws a message without the key', async () => {
  await assert.rejects(fetchLunoBalances({ keyId: 'id', keySecret: 'topsecret', fetchImpl: async () => json({}, 401) }), (error) => {
    assert.match(error.message, /401/);
    assert.ok(!error.message.includes('topsecret'));
    return true;
  });
});

test('Pionex: signed GET, free plus frozen, USDT becomes Pionex Cash', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return json({ result: true, data: { balances: [{ coin: 'USDT', free: '10.5', frozen: '1.5' }, { coin: 'BTC', free: '0', frozen: '0' }] } });
  };
  const rows = await fetchPionexBalances({ apiKey: 'k', apiSecret: 's', fetchImpl, now: 1700000000000 });
  assert.equal(seen.url, 'https://api.pionex.com/api/v1/account/balances?timestamp=1700000000000');
  assert.equal(seen.init.headers['PIONEX-KEY'], 'k');
  assert.equal(seen.init.headers['PIONEX-SIGNATURE'], await sign('s', 'GET/api/v1/account/balances?timestamp=1700000000000'));
  assert.deepEqual(rows, [{ asset: 'Pionex Cash', qty: 12 }]);
});

test('Pionex: result false is an error', async () => {
  await assert.rejects(fetchPionexBalances({ apiKey: 'k', apiSecret: 's', fetchImpl: async () => json({ result: false, code: 'PERMISSION_DENIED' }) }), /PERMISSION_DENIED/);
});

function createFakeNetwork({ lunoStatus = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).startsWith('https://api.luno.com')) return json({ balance: [{ asset: 'XBT', balance: '1' }] }, lunoStatus);
    if (String(url).startsWith('https://api.pionex.com')) return json({ result: true, data: { balances: [{ coin: 'USDT', free: '5', frozen: '0' }] } });
    return new Response(null, { status: 204 });
  };
  return { calls, fetchImpl };
}
const baseEnv = { SUPABASE_URL: 'https://x.supabase.co/', SUPABASE_SERVICE_KEY: 'sb_secret_abc', LUNO_KEY_ID: 'a', LUNO_KEY_SECRET: 'b', PIONEX_API_KEY: 'c', PIONEX_API_SECRET: 'd' };

test('sync: writes balances and status, uses the service key, removes stale rows', async () => {
  const { calls, fetchImpl } = createFakeNetwork();
  const outcomes = await runBrokerSync(baseEnv, { fetchImpl, now: () => new Date('2026-10-29T10:00:00Z') });
  assert.deepEqual(outcomes.map((o) => [o.broker, o.ok]), [['Luno', true], ['Pionex', true]]);

  const database = calls.filter((call) => call.url.includes('supabase.co'));
  assert.ok(database.every((call) => call.init.headers.apikey === 'sb_secret_abc'));
  assert.ok(database.every((call) => !call.init.headers.Authorization), 'new-style keys go in apikey only');
  assert.ok(database.some((call) => call.url.includes('broker_balances?on_conflict=broker,asset') && call.init.body.includes('"asset":"BTC"')));
  assert.ok(database.some((call) => call.init.method === 'DELETE' && call.url.includes('broker=eq.Luno&synced_at=lt.')));
  assert.ok(database.some((call) => call.url.includes('broker_sync_status') && call.init.body.includes('"ok":true')));
});

test('sync: one failing broker is recorded and does not stop the other', async () => {
  const { calls, fetchImpl } = createFakeNetwork({ lunoStatus: 401 });
  const outcomes = await runBrokerSync(baseEnv, { fetchImpl });
  assert.equal(outcomes[0].ok, false);
  assert.equal(outcomes[1].ok, true);
  const failure = calls.find((call) => call.url.includes('broker_sync_status') && call.init.body.includes('"ok":false'));
  assert.ok(failure);
  assert.ok(!failure.init.body.includes('"b"'));
});

test('sync: a broker without secrets is skipped, missing database secrets stop everything', async () => {
  const { calls, fetchImpl } = createFakeNetwork();
  const outcomes = await runBrokerSync({ ...baseEnv, PIONEX_API_KEY: '' }, { fetchImpl });
  assert.deepEqual(outcomes.map((o) => o.broker), ['Luno']);
  assert.ok(!calls.some((call) => call.url.includes('pionex')));

  const none = await runBrokerSync({}, { fetchImpl });
  assert.equal(none[0].ok, false);
});

test('reconcile: matches, differences and missing rows, only for synced brokers', () => {
  const rows = reconcileBalances({
    syncedBrokers: ['Luno'],
    brokerBalances: [
      { broker: 'Luno', asset: 'BTC', qty: 0.5 }, { broker: 'Luno', asset: 'ETH', qty: 2 },
      { broker: 'Luno', asset: 'Luno Cash', qty: 0.11 }, { broker: 'Pionex', asset: 'BTC', qty: 9 },
    ],
    positions: [
      { broker: 'Luno', asset: 'BTC', qty: 0.50000000001 }, { broker: 'Luno', asset: 'ETH', qty: 1 },
      { broker: 'Luno', asset: 'ADA', qty: 100 }, { broker: 'Luno', asset: 'Luno Cash', qty: 0 },
      { broker: 'Pionex', asset: 'BTC', qty: 1 },
    ],
  });
  const stateOf = (asset) => rows.find((row) => row.asset === asset)?.state;
  assert.equal(stateOf('BTC'), MATCH_STATES.match);
  assert.equal(stateOf('ETH'), MATCH_STATES.differs);
  assert.equal(stateOf('ADA'), MATCH_STATES.missingAtBroker);
  assert.equal(stateOf('Luno Cash'), MATCH_STATES.missingInLedger);
  assert.equal(rows.length, 4, 'Pionex is not compared because it has no successful read');
});

// ---------- IBKR ----------

const REPORT = `<FlexQueryResponse queryName="x" type="AF"><FlexStatements count="1"><FlexStatement accountId="U1">
<OpenPositions>
  <OpenPosition symbol="VOO" assetCategory="STK" position="2.5" currency="USD" levelOfDetail="SUMMARY" />
  <OpenPosition symbol="VOO" assetCategory="STK" position="1" currency="USD" levelOfDetail="LOT" />
  <OpenPosition symbol="QQQM" assetCategory="STK" position="0" currency="USD" levelOfDetail="SUMMARY" />
</OpenPositions>
<CashReport>
  <CashReportCurrency currency="BASE_SUMMARY" endingCash="500" />
  <CashReportCurrency currency="USD" endingCash="123.45" />
  <CashReportCurrency currency="GBP" endingCash="10" />
</CashReport></FlexStatement></FlexStatements></FlexQueryResponse>`;

test('IBKR: report parsing counts summary lines once and names the cash accounts', () => {
  assert.deepEqual(parseFlexReport(REPORT), [
    { asset: 'VOO', qty: 2.5 }, { asset: 'IBKR Cash', qty: 123.45 }, { asset: 'IBKR Cash (GBP)', qty: 10 },
  ]);
});

test('IBKR: sends the request, waits while the report is generated, then parses it', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    if (url.includes('SendRequest')) return new Response('<FlexStatementResponse><Status>Success</Status><ReferenceCode>REF1</ReferenceCode><Url>https://evil.example.com/steal</Url></FlexStatementResponse>');
    if (urls.filter((u) => u.includes('GetStatement') || u.includes('evil')).length < 2) {
      return new Response('<FlexStatementResponse><Status>Warn</Status><ErrorCode>1019</ErrorCode><ErrorMessage>Statement generation in progress. Please try again shortly.</ErrorMessage></FlexStatementResponse>');
    }
    return new Response(REPORT);
  };
  const rows = await fetchIbkrBalances({ token: 'tok', queryId: '42', fetchImpl, wait: async () => {} });
  assert.equal(rows.length, 3);
  assert.match(urls[0], /SendRequest\?t=tok&q=42&v=3/);
  assert.ok(urls.slice(1).every((url) => url.startsWith('https://ndcdyn.interactivebrokers.com/') && url.includes('q=REF1')), 'the token goes only to Interactive Brokers');
});

test('IBKR: a refused request reports the code and never the token', async () => {
  const fetchImpl = async () => new Response('<FlexStatementResponse><Status>Fail</Status><ErrorCode>1012</ErrorCode><ErrorMessage>Token has expired.</ErrorMessage></FlexStatementResponse>');
  await assert.rejects(fetchIbkrBalances({ token: 'SECRET-TOKEN', queryId: '42', fetchImpl, wait: async () => {} }), (error) => {
    assert.match(error.message, /1012/);
    assert.ok(!error.message.includes('SECRET-TOKEN'));
    return true;
  });
});

test('IBKR: gives up with a clear message when the report never finishes', async () => {
  const fetchImpl = async (url) => new Response(url.includes('SendRequest')
    ? '<FlexStatementResponse><Status>Success</Status><ReferenceCode>R</ReferenceCode></FlexStatementResponse>'
    : '<FlexStatementResponse><Status>Warn</Status><ErrorCode>1019</ErrorCode></FlexStatementResponse>');
  await assert.rejects(fetchIbkrBalances({ token: 't', queryId: '1', fetchImpl, wait: async () => {} }), /did not finish/);
});

test('sync: IBKR runs only in its scheduled hour unless IBKR_ALWAYS is set', async () => {
  const env = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_KEY: 'k', IBKR_FLEX_TOKEN: 't', IBKR_FLEX_QUERY_ID: '1' };
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).includes('SendRequest')) return new Response('<FlexStatementResponse><Status>Fail</Status><ErrorCode>1</ErrorCode></FlexStatementResponse>');
    return new Response(null, { status: 204 });
  };
  const off = await runBrokerSync(env, { fetchImpl, now: () => new Date('2026-10-30T07:20:00Z') });
  assert.deepEqual(off, []);
  const on = await runBrokerSync(env, { fetchImpl, now: () => new Date('2026-10-30T06:05:00Z') });
  assert.equal(on[0].broker, 'IBKR');
  const forced = await runBrokerSync({ ...env, IBKR_ALWAYS: 'true' }, { fetchImpl, now: () => new Date('2026-10-30T07:20:00Z') });
  assert.equal(forced[0].broker, 'IBKR');
});

test('sync: names the missing secrets so the cause is clear', async () => {
  const none = await runBrokerSync({ SUPABASE_URL: 'https://x.supabase.co' }, { fetchImpl: async () => new Response(null, { status: 204 }) });
  assert.match(none[0].message, /SUPABASE_SERVICE_KEY/);
  const noBroker = await runBrokerSync({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_KEY: 'k' }, { fetchImpl: async () => new Response(null, { status: 204 }) });
  assert.match(noBroker[0].message, /No broker secrets/);
});

test('sync: a database that rejects the key is reported, not hidden', async () => {
  const fetchImpl = async (url) => (String(url).includes('supabase.co') ? new Response('{}', { status: 401 }) : new Response(JSON.stringify({ balance: [] })));
  const outcomes = await runBrokerSync({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_KEY: 'bad', LUNO_KEY_ID: 'a', LUNO_KEY_SECRET: 'b' }, { fetchImpl });
  assert.ok(outcomes.some((outcome) => outcome.message.includes('SUPABASE_SERVICE_KEY')));
});

// ---------- Trade history ----------

const trade = (overrides) => ({ externalId: 'x:1', broker: 'Luno', asset: 'BTC', side: 'buy', baseQty: 0.01, quoteAmount: 3000, quoteCurrency: 'MYR', tradedAt: 1761800000000, ...overrides });

test('trade row: a buy costs the amount plus the fee, and a fee in the asset reduces the units', () => {
  const withQuoteFee = toTradeRow(trade({ feeQuote: 7.5 }));
  assert.equal(withQuoteFee.qty, 0.01);
  assert.equal(withQuoteFee.cash_amount, 3007.5);
  assert.equal(withQuoteFee.fee_quote, 7.5);

  const withAssetFee = toTradeRow(trade({ feeBase: 0.00002 }));
  assert.equal(withAssetFee.qty, 0.00998);
  assert.equal(withAssetFee.cash_amount, 3000);
});

test('trade row: a sale pays the amount minus the fee, and an asset fee is counted in money', () => {
  const sale = toTradeRow(trade({ side: 'sell', feeQuote: 6, feeBase: 0.00001 }));
  assert.equal(sale.qty, 0.01);
  assert.equal(sale.fee_quote, 6 + 0.00001 * 300000);
  assert.equal(sale.cash_amount, 3000 - sale.fee_quote);
});

test('trade row: unusable trades are dropped', () => {
  assert.equal(toTradeRow(trade({ baseQty: 0 })), null);
  assert.equal(toTradeRow(trade({ quoteAmount: NaN })), null);
  assert.equal(toTradeRow(trade({ externalId: '' })), null);
});

test('Luno trades: reads each coin against MYR, skips unknown pairs, never sends the secret in the address', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    if (String(url).includes('pair=XBTMYR')) {
      return json({ trades: [
        { sequence: 5, timestamp: 1761800000000, is_buy: true, volume: '0.01', counter: '3000', fee_base: '0', fee_counter: '4.5' },
        { sequence: 6, timestamp: 1761800100000, is_buy: false, volume: '0.005', counter: '1500', fee_base: '0', fee_counter: '2' },
      ] });
    }
    return json({}, 400);
  };
  const rows = await fetchLunoTrades({ keyId: 'id', keySecret: 'topsecret', fetchImpl });
  assert.deepEqual(rows.map((r) => [r.external_id, r.side, r.qty, r.cash_amount]), [['luno:XBTMYR:5', 'buy', 0.01, 3004.5], ['luno:XBTMYR:6', 'sell', 0.005, 1498]]);
  assert.ok(urls.every((url) => !url.includes('topsecret')));
  assert.equal(urls.length, 6);
});

test('Luno trades: a refused key is an error, and a full page leads to the next page', async () => {
  await assert.rejects(fetchLunoTrades({ keyId: 'a', keySecret: 'b', fetchImpl: async () => json({}, 403) }), /403/);

  const pages = [];
  const full = Array.from({ length: 100 }, (_, index) => ({ sequence: 1000 - index, timestamp: 1761800000000 - index, is_buy: true, volume: '0.01', counter: '10' }));
  const fetchImpl = async (url) => {
    if (!String(url).includes('pair=XBTMYR')) return json({ trades: [] });
    pages.push(String(url));
    return json({ trades: pages.length === 1 ? full : [] });
  };
  const rows = await fetchLunoTrades({ keyId: 'a', keySecret: 'b', fetchImpl, pages: 3 });
  assert.equal(rows.length, 100);
  assert.equal(pages.length, 2);
  assert.match(pages[1], /before=1761799999901/);
});

test('Pionex trades: signed request per market, fee coin rules, unknown market skipped', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), headers: init.headers });
    if (String(url).includes('symbol=BTC_USDT')) {
      return json({ result: true, data: { fills: [
        { id: 11, side: 'BUY', price: '100000', size: '0.01', fee: '1.5', feeCoin: 'USDT', timestamp: 1761800000000 },
        { id: 12, side: 'BUY', price: '100000', size: '0.01', fee: '0.00001', feeCoin: 'BTC', timestamp: 1761800001000 },
        { id: 13, side: 'SELL', price: '100000', size: '0.01', fee: '1', feeCoin: 'USDT', timestamp: 1761800002000 },
      ] } });
    }
    return json({ result: false, code: 'TRADE_INVALID_SYMBOL' });
  };
  const rows = await fetchPionexTrades({ apiKey: 'k', apiSecret: 's', fetchImpl, now: () => 1761800005000 });
  assert.deepEqual(rows.map((r) => [r.external_id, r.side, r.qty, r.cash_amount]), [['pionex:11', 'buy', 0.01, 1001.5], ['pionex:12', 'buy', 0.00999, 1000], ['pionex:13', 'sell', 0.01, 999]]);
  const first = seen[0];
  assert.match(first.url, /fills\?symbol=BTC_USDT&timestamp=1761800005000$/);
  assert.equal(first.headers['PIONEX-SIGNATURE'], await sign('s', 'GET/api/v1/trade/fills?symbol=BTC_USDT&timestamp=1761800005000'));
});

test('sync: trades are saved, a trade failure is noted but the balances still count as read', async () => {
  const calls = [];
  let tradesFail = false;
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('listtrades')) {
      return tradesFail ? json({}, 500) : json({ trades: [{ sequence: 1, timestamp: 1761800000000, is_buy: true, volume: '0.01', counter: '3000' }] });
    }
    if (String(url).startsWith('https://api.luno.com')) return json({ balance: [{ asset: 'XBT', balance: '1' }] });
    return new Response(null, { status: 204 });
  };
  const env = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_KEY: 'k', LUNO_KEY_ID: 'a', LUNO_KEY_SECRET: 'b' };

  await runBrokerSync(env, { fetchImpl });
  assert.ok(calls.some((call) => call.url.includes('broker_trades?on_conflict=external_id') && call.init.body.includes('luno:XBTMYR:1')));

  calls.length = 0;
  tradesFail = true;
  const outcomes = await runBrokerSync(env, { fetchImpl });
  assert.equal(outcomes[0].ok, true);
  assert.match(outcomes[0].message, /Trades: Luno answered with status 500/);
  assert.ok(calls.some((call) => call.url.includes('broker_sync_status') && call.init.body.includes('"ok":true') && call.init.body.includes('Trades:')));
});


test('Pionex trades: requests are spaced, and a 429 stops everything without a retry', async () => {
  const waits = [];
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    if (String(url).includes('symbol=BTC_USDT')) return json({ result: true, data: { fills: [{ id: 1, side: 'BUY', price: '50000', size: '0.1', fee: '0', feeCoin: 'USDT', timestamp: 1761800000000 }] } });
    return new Response('Too many requests', { status: 429 });
  };
  const rows = await fetchPionexTrades({ apiKey: 'k', apiSecret: 's', fetchImpl, now: () => 1761800005000, wait: async (ms) => waits.push(ms) });
  assert.equal(rows.isLimited, true);
  assert.deepEqual(rows.map((r) => r.external_id), ['pionex:1'], 'what was read before the limit is kept');
  assert.equal(urls.length, 2, 'no request after the 429, and no retry of it');
  assert.deepEqual(waits, [700, 700], 'a pause before every request');
});

test('Pionex balances: a 429 gives a clear message', async () => {
  await assert.rejects(fetchPionexBalances({ apiKey: 'k', apiSecret: 's', fetchImpl: async () => new Response('', { status: 429 }) }), /rate limit/);
});

test('sync: a Pionex rate limit is noted, the partial trades are saved, and balances still count as read', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('fills')) return new Response('', { status: 429 });
    if (String(url).startsWith('https://api.pionex.com')) return json({ result: true, data: { balances: [{ coin: 'USDT', free: '5', frozen: '0' }] } });
    return new Response(null, { status: 204 });
  };
  const env = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_KEY: 'k', PIONEX_API_KEY: 'a', PIONEX_API_SECRET: 'b' };
  const outcomes = await runBrokerSync(env, { fetchImpl, wait: async () => {} });
  assert.equal(outcomes[0].ok, true);
  assert.match(outcomes[0].message, /rate limit/);
});
