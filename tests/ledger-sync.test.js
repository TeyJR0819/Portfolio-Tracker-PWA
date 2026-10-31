import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { runLedgerSync } from '../src/ledger-sync.js';
import worker, { LEDGER_CRON } from '../src/worker.js';

const ENV = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_KEY: 'sb_secret_test' };
const T0 = Date.parse('2026-10-01T04:00:00Z');
const DAY = 86400000;

const trade = (id, overrides = {}) => ({
  external_id: id, broker: 'Luno', asset: 'BTC', side: 'buy', qty: 0.01, cash_amount: 3000, fee_quote: 0,
  quote_currency: 'MYR', traded_at: new Date(T0).toISOString(), ...overrides,
});

// An in-memory stand-in for Supabase's REST interface, with the unique trade id on transactions.
function createFakeSupabase({ tables = {}, hooks = {} } = {}) {
  const data = { portfolio: [], transactions: [], broker_trades: [], broker_balances: [], broker_sync_status: [], ...tables };
  let nextId = 1000;
  const log = [];

  const fetchImpl = async (url, init = {}) => {
    const address = new URL(String(url));
    if (address.hostname === 'api.coingecko.com') {
      return hooks.noRate ? new Response('{}', { status: 500 }) : Response.json({ tether: { myr: 4.1 } });
    }
    const table = address.pathname.split('/').pop();
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    log.push(`${method} ${table}${address.search}`);
    if (hooks.fail?.({ method, table, address, body })) return Response.json({ code: 'XX000', message: 'simulated failure' }, { status: 500 });

    const filter = address.searchParams.get('id');
    const matches = (row) => {
      if (!filter) return true;
      if (filter.startsWith('eq.')) return String(row.id) === filter.slice(3);
      if (filter.startsWith('in.(')) return filter.slice(4, -1).split(',').includes(String(row.id));
      return true;
    };

    if (method === 'GET') {
      let rows = [...data[table]];
      if (address.searchParams.get('external_id') === 'not.is.null') rows = rows.filter((row) => row.external_id);
      if (hooks.staleImported && table === 'transactions') rows = [];
      if (address.searchParams.get('order') === 'id.desc') rows.sort((a, b) => b.id - a.id);
      const offset = Number(address.searchParams.get('offset') ?? 0);
      const limit = Number(address.searchParams.get('limit') ?? 1000);
      return Response.json(rows.slice(offset, offset + limit));
    }
    if (method === 'POST' && address.searchParams.has('on_conflict')) {
      for (const row of body) {
        const index = data[table].findIndex((existing) => existing.broker === row.broker);
        if (index >= 0) data[table][index] = row; else data[table].push(row);
      }
      return new Response(null, { status: 204 });
    }
    if (method === 'POST') {
      if (table === 'transactions') {
        const taken = new Set(data.transactions.map((row) => row.external_id).filter(Boolean));
        if (body.some((row) => row.external_id && taken.has(row.external_id))) return Response.json({ code: '23505', message: 'duplicate key' }, { status: 409 });
      }
      const created = body.map((row) => ({ id: nextId++, ...row }));
      data[table].push(...created);
      return Response.json(created, { status: 201 });
    }
    if (method === 'PATCH') {
      const changed = data[table].filter(matches);
      changed.forEach((row) => Object.assign(row, body));
      return Response.json(changed);
    }
    if (method === 'DELETE') {
      data[table] = data[table].filter((row) => !matches(row));
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 405 });
  };
  return { data, fetchImpl, log };
}

const baseTables = () => ({
  broker_sync_status: [{ broker: 'Luno', ok: true }, { broker: 'Pionex', ok: true }],
  broker_balances: [{ broker: 'Luno', asset: 'Luno Cash', qty: 250.5 }, { broker: 'Luno', asset: 'BTC', qty: 0.01 }, { broker: 'Pionex', asset: 'Pionex Cash', qty: 40 }],
  broker_trades: [
    trade('luno:XBTMYR:1', { qty: 0.02, cash_amount: 6009, fee_quote: 9, traded_at: new Date(T0).toISOString() }),
    trade('luno:XBTMYR:2', { side: 'sell', qty: 0.01, cash_amount: 3500, fee_quote: 5, traded_at: new Date(T0 + DAY).toISOString() }),
    trade('pionex:7', { broker: 'Pionex', qty: 0.001, cash_amount: 100.1, fee_quote: 0.1, quote_currency: 'USDT', traded_at: new Date(T0 + 2 * DAY).toISOString() }),
  ],
});

const find = (data, broker, asset) => data.portfolio.find((row) => row.broker === broker && row.asset === asset);
const run = (fake) => runLedgerSync(ENV, { fetchImpl: fake.fetchImpl, now: () => new Date('2026-10-30T06:00:00Z') });

test('ledger sync: records every trade, sets the cash to the broker balance, and writes each balance once', async () => {
  const fake = createFakeSupabase({ tables: baseTables() });
  const outcome = await run(fake);

  assert.equal(outcome.ok, true, outcome.message);
  assert.match(outcome.message, /3 trades recorded/);
  assert.match(outcome.message, /2 cash balances synced/);

  const lunoBtc = find(fake.data, 'Luno', 'BTC');
  assert.equal(lunoBtc.qty, 0.01);
  assert.equal(lunoBtc.cost_myr, 3004.5, 'half of the RM 6009 cost is left');
  assert.equal(lunoBtc.realised_pl, 3500 - 3004.5, "the RM 3500 received already has the fee taken off");
  assert.equal(find(fake.data, 'Pionex', 'BTC').cost_myr, 410.41, 'USDT 100.1 at RM 4.1');
  assert.equal(find(fake.data, 'Luno', 'Luno Cash').qty, 250.5);
  assert.equal(find(fake.data, 'Pionex', 'Pionex Cash').qty, 40);

  const tradeLines = fake.data.transactions.filter((row) => row.external_id);
  assert.deepEqual(tradeLines.map((row) => row.external_id), ['luno:XBTMYR:1', 'luno:XBTMYR:2', 'pionex:7']);
  assert.equal(tradeLines[0].note, 'Imported from Luno');
  assert.equal(tradeLines[0].trade_date, '2026-10-01');

  const posts = fake.log.filter((line) => line.startsWith('POST transactions'));
  assert.equal(posts.length, 1, 'all history lines go in one request');
  const status = fake.data.broker_sync_status.find((row) => row.broker === 'Ledger');
  assert.equal(status.ok, true);
});

test('ledger sync: a second run changes nothing', async () => {
  const fake = createFakeSupabase({ tables: baseTables() });
  await run(fake);
  const snapshot = JSON.stringify([fake.data.portfolio, fake.data.transactions]);
  fake.log.length = 0;

  const outcome = await run(fake);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.message, '');
  assert.equal(JSON.stringify([fake.data.portfolio, fake.data.transactions]), snapshot);
  assert.ok(!fake.log.some((line) => /^(POST|PATCH|DELETE) (portfolio|transactions)/.test(line)), 'no ledger write');
});

test('ledger sync: a new trade later is added on top, and cash follows the broker again', async () => {
  const fake = createFakeSupabase({ tables: baseTables() });
  await run(fake);
  fake.data.broker_trades.push(trade('luno:XBTMYR:3', { qty: 0.005, cash_amount: 1500, traded_at: new Date(T0 + 3 * DAY).toISOString() }));
  fake.data.broker_balances.find((row) => row.asset === 'Luno Cash').qty = 100;
  fake.data.broker_balances.find((row) => row.asset === 'BTC').qty = 0.015;

  const outcome = await run(fake);
  assert.match(outcome.message, /1 trade recorded/);
  assert.equal(find(fake.data, 'Luno', 'BTC').qty, 0.015);
  assert.equal(find(fake.data, 'Luno', 'Luno Cash').qty, 100);
});

test('ledger sync: a trade already recorded by another run is detected and nothing changes', async () => {
  const fake = createFakeSupabase({ tables: baseTables() });
  await run(fake);
  const portfolioBefore = JSON.stringify(fake.data.portfolio);

  const racing = createFakeSupabase({ tables: { ...baseTables(), portfolio: [], transactions: fake.data.transactions }, hooks: { staleImported: true } });
  const outcome = await run(racing);
  assert.equal(outcome.ok, false);
  assert.match(outcome.message, /already in the ledger/);
  assert.equal(racing.data.portfolio.length, 0, 'no balance was written');
  assert.equal(racing.data.transactions.length, fake.data.transactions.length, 'no history line was added');
  assert.equal(JSON.stringify(fake.data.portfolio), portfolioBefore);
});

test('ledger sync: a failed balance save undoes the history and the earlier balances', async () => {
  let patches = 0;
  const fake = createFakeSupabase({
    tables: { ...baseTables(), portfolio: [{ id: 1, category: 'Cash', broker: 'Luno', asset: 'Luno Cash', qty: 5000, cost_myr: 5000, realised_pl: 0 }] },
    hooks: { fail: ({ method, table }) => method === 'POST' && table === 'portfolio' && (patches += 1) === 2 },
  });
  const before = JSON.stringify(fake.data.portfolio);

  const outcome = await run(fake);
  assert.equal(outcome.ok, false);
  assert.match(outcome.message, /Nothing was changed/);
  assert.equal(fake.data.transactions.length, 0, 'the history lines were removed again');
  assert.equal(JSON.stringify(fake.data.portfolio.filter((row) => row.id === 1)), before, 'the existing balance is back to its old value');
  assert.ok(!fake.data.portfolio.some((row) => row.id >= 1000), 'rows created by this run were removed');
});

test('ledger sync: a sale with no earlier purchase gets an opening balance at the sale price, and later trades still go in', async () => {
  const tables = baseTables();
  tables.broker_trades = [
    trade('luno:ADAMYR:1', { asset: 'ADA', side: 'sell', qty: 12.57, cash_amount: 25.14, traded_at: new Date(T0).toISOString() }),
    trade('luno:XBTMYR:2', { qty: 0.01, cash_amount: 3000, traded_at: new Date(T0 + DAY).toISOString() }),
    trade('luno:ADAMYR:3', { asset: 'ADA', qty: 100, cash_amount: 250, traded_at: new Date(T0 + 2 * DAY).toISOString() }),
  ];
  tables.broker_balances.push({ broker: 'Luno', asset: 'ADA', qty: 100 });
  const fake = createFakeSupabase({ tables });
  const outcome = await run(fake);

  assert.equal(outcome.ok, true, outcome.message);
  assert.match(outcome.message, /3 trades recorded/);
  assert.match(outcome.message, /1 sale had no earlier purchase/);
  const ada = find(fake.data, 'Luno', 'ADA');
  assert.equal(ada.qty, 100, 'the 12.57 coins were added and sold again');
  assert.equal(ada.cost_myr, 250);
  assert.equal(ada.realised_pl, 0, 'no profit or loss on coins that had no recorded cost');
  assert.equal(find(fake.data, 'Luno', 'BTC').qty, 0.01, 'the Bitcoin trade is not held back');
  assert.ok(fake.data.transactions.some((row) => row.note === 'Opening balance: no purchase found in the history' && !row.external_id));
});

test('ledger sync: a problem with one coin holds back only that coin', async () => {
  const tables = baseTables();
  tables.broker_trades = [
    trade('pionex:1', { broker: 'Pionex', quote_currency: 'USDT', qty: 0.001, cash_amount: 100 }),
    trade('luno:XBTMYR:1', { traded_at: new Date(T0 + DAY).toISOString() }),
  ];
  const fake = createFakeSupabase({ tables, hooks: { noRate: true } });
  const outcome = await run(fake);
  assert.match(outcome.message, /1 trade recorded/);
  assert.match(outcome.message, /Held back the Pionex buy/);
  assert.equal(find(fake.data, 'Luno', 'BTC').qty, 0.01);
  assert.ok(!find(fake.data, 'Pionex', 'BTC'));
});

test('ledger sync: coins that the history cannot explain are corrected to the Luno balance, and the correction is shown', async () => {
  const tables = baseTables();
  tables.broker_balances.find((row) => row.asset === 'BTC').qty = 0.012;
  const fake = createFakeSupabase({ tables });
  const outcome = await run(fake);
  assert.match(outcome.message, /Luno balance corrected \(not explained by the history\): BTC \+0\.002/);
  const btc = find(fake.data, 'Luno', 'BTC');
  assert.equal(btc.qty, 0.012);
  assert.equal(btc.cost_myr, 3605.4, 'added coins carry the average cost of RM 300450 per BTC');
  assert.ok(fake.data.transactions.some((row) => row.kind === 'adjust' && row.asset === 'BTC'));
});

test('ledger sync: without an exchange rate the Pionex trades wait and the rest still works', async () => {
  const fake = createFakeSupabase({ tables: baseTables(), hooks: { noRate: true } });
  const outcome = await run(fake);
  assert.match(outcome.message, /2 trades recorded/);
  assert.match(outcome.message, /rate is not available/);
  assert.ok(!fake.data.transactions.some((row) => row.external_id === 'pionex:7'));
});

test('ledger sync: waits until a broker has been read, and ignores a broker that failed', async () => {
  const none = createFakeSupabase({ tables: { ...baseTables(), broker_sync_status: [] } });
  assert.match((await run(none)).message, /Waiting for the first broker read/);
  assert.equal(none.data.portfolio.length, 0);

  const luno = createFakeSupabase({ tables: { ...baseTables(), broker_sync_status: [{ broker: 'Luno', ok: true }, { broker: 'Pionex', ok: false }] } });
  await run(luno);
  assert.ok(find(luno.data, 'Luno', 'Luno Cash'));
  assert.ok(!find(luno.data, 'Pionex', 'Pionex Cash'), 'a failed broker read never changes its cash');
});

test('ledger sync: missing secrets are named, and a database error is reported without the key', async () => {
  assert.match((await runLedgerSync({}, {})).message, /SUPABASE_SERVICE_KEY/);
  const outcome = await runLedgerSync(ENV, { fetchImpl: async () => new Response('{}', { status: 401 }) });
  assert.equal(outcome.ok, false);
  assert.ok(!outcome.message.includes('sb_secret_test'));
});

test('schedules: the ledger schedule in wrangler.toml matches the Worker, and each schedule runs its own job', async () => {
  assert.ok(readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8').includes(`"${LEDGER_CRON}"`));

  const original = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => { urls.push(String(url)); return Response.json([]); };
  try {
    const env = { ...ENV, LUNO_KEY_ID: 'a', LUNO_KEY_SECRET: 'b' };
    for (const cron of [LEDGER_CRON, '*/15 * * * *']) {
      urls.length = 0;
      let pending;
      await worker.scheduled({ cron }, env, { waitUntil: (promise) => { pending = promise; } });
      await pending;
      if (cron === LEDGER_CRON) assert.ok(urls.every((url) => !url.includes('luno.com')) && urls.some((url) => url.includes('broker_sync_status')));
      else assert.ok(urls.some((url) => url.includes('api.luno.com')));
    }
  } finally {
    globalThis.fetch = original;
  }
});
