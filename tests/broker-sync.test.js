import assert from 'node:assert/strict';
import { test } from 'node:test';

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
