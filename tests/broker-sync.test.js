import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fetchIbkrBalances, parseFlexReport } from '../src/brokers/ibkr.js';
import { fetchLunoBalances } from '../src/brokers/luno.js';
import { fetchPionexBalances, sign } from '../src/brokers/pionex.js';
import { runBrokerSync } from '../src/brokers/sync.js';
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
