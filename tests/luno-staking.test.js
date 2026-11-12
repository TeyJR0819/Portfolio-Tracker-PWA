import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fetchLunoBalances, fetchLunoTransfers, pairOwnMoves } from '../src/brokers/luno.js';
import { getTradableAssetsForBroker, getCashAssetForBroker } from '../public/js/logic/catalog.js';
import { planTradeImport } from '../src/trade-import.js';

const AUTH = { keyId: 'id', keySecret: 'secret' };
const json = (body) => ({ ok: true, status: 200, json: async () => body });

function fakeLuno({ wallet, staking = [], transactions = {} }) {
  return async (url) => {
    const text = String(url);
    if (text.includes('account_type=STAKING') && !text.includes('TRANSACTIONAL')) return json({ balance: staking });
    if (text.includes('account_type=TRANSACTIONAL')) return json({ balance: [...wallet, ...staking] });
    if (text.endsWith('/balance')) return json({ balance: wallet });
    const id = text.match(/accounts\/(\w+)\/transactions/)?.[1];
    return json({ transactions: transactions[id] ?? [] });
  };
}

const wallet = [
  { account_id: 'myr1', asset: 'MYR', balance: '200', account_type: 'TRANSACTIONAL' },
  { account_id: 'w1', asset: 'ADA', balance: '100', account_type: 'TRANSACTIONAL' },
];
const staking = [{ account_id: 's1', asset: 'ADA', balance: '50.5', account_type: 'STAKING' }];

test('balances: the staking wallet is added to the normal wallet', async () => {
  const rows = await fetchLunoBalances({ ...AUTH, fetchImpl: fakeLuno({ wallet, staking }) });
  assert.deepEqual(rows, [
    { asset: 'Luno Cash', qty: 200 },
    { asset: 'ADA', qty: 150.5 },
  ]);
});

test('transfers: Instant Buy matches MYR cash spent, staking principal moves cancel out, and staking reward is RM 0.00', async () => {
  const t0 = 1_750_000_000_000;
  const tStake = 1_760_000_000_000;
  const transactions = {
    myr1: [
      { row_index: 1, timestamp: t0, balance_delta: '-294.00', kind: 'EXCHANGE', reference: 'inst-1', description: 'Bought ADA' },
      { row_index: 2, timestamp: t0, balance_delta: '-6.00', kind: 'FEE', reference: 'inst-1', description: 'Fee for bought ADA' },
    ],
    w1: [
      { row_index: 1, timestamp: t0, balance_delta: '150', kind: 'EXCHANGE', reference: 'inst-1', description: 'Bought 150 ADA' },
      { row_index: 2, timestamp: tStake, balance_delta: '-50', kind: 'TRANSFER', reference: 'stk-1', description: 'Transfer to staking' },
    ],
    s1: [
      { row_index: 1, timestamp: tStake + 1000, balance_delta: '50', kind: 'TRANSFER', reference: 'stk-1', description: 'Transfer from wallet' },
      { row_index: 2, timestamp: tStake + 86_400_000, balance_delta: '0.5', kind: 'INTEREST', description: 'Staking reward' },
    ],
  };

  const rows = await fetchLunoTransfers({ ...AUTH, pages: 0, fetchImpl: fakeLuno({ wallet, staking, transactions }) });
  assert.equal(rows.length, 2);

  // 1. Instant Buy of 150 ADA for RM 300.00 (including RM 6.00 fee)
  const instantBuy = rows.find((r) => r.external_id === 'luno:inflow:w1:1');
  assert.ok(instantBuy);
  assert.equal(instantBuy.side, 'buy');
  assert.equal(instantBuy.qty, 150);
  assert.equal(instantBuy.cash_amount, 300);
  assert.equal(instantBuy.fee_quote, 6);

  // 2. Staking reward of 0.5 ADA at RM 0.00
  const reward = rows.find((r) => r.external_id === 'luno:reward:s1:2');
  assert.ok(reward);
  assert.equal(reward.side, 'staking_reward');
  assert.equal(reward.qty, 0.5);
  assert.equal(reward.cash_amount, 0);

  // Verify ledger import combines principal + reward to match Luno balance (150.5 ADA) with RM 300.00 cost basis
  const trades = rows.map((r) => ({
    externalId: r.external_id,
    broker: r.broker,
    asset: r.asset,
    side: r.side,
    qty: r.qty,
    cashAmount: r.cash_amount,
    feeQuote: r.fee_quote,
    quoteCurrency: r.quote_currency,
    tradedAt: Date.parse(r.traded_at),
  }));
  const imported = planTradeImport({ trades, positions: [], marketPrices: {} });
  const adaPos = imported.positions.find((p) => p.broker === 'Luno' && p.asset === 'ADA');
  assert.equal(adaPos.qty, 150.5);
  assert.equal(adaPos.costMyr, 300);
});

test('pairing: only equal and opposite moves between two accounts are paired', () => {
  const a = { account: { id: 'w', asset: 'ADA' }, delta: -10, timestamp: 0 };
  const b = { account: { id: 's', asset: 'ADA' }, delta: 10, timestamp: 1000 };
  const c = { account: { id: 's', asset: 'ADA' }, delta: 3, timestamp: 1000 };
  assert.deepEqual([...pairOwnMoves([a, c, b])].sort(), [0, 2]);
});

test('Webull holds the same stocks and a cash account like Moomoo', () => {
  const names = [...getTradableAssetsForBroker('Webull').map((entry) => entry.asset), getCashAssetForBroker('Webull')];
  assert.deepEqual(names.sort(), ['QQQM', 'SMH', 'SSO', 'VOO', 'Webull Cash']);
});

test('transfers: two instant buys close together each keep their own RM cost', async () => {
  const t = 1_760_000_000_000;
  const transactions = {
    myr1: [
      { row_index: 1, timestamp: t, balance_delta: '-50', kind: 'EXCHANGE', description: 'Instant order' },
      { row_index: 2, timestamp: t + 20_000, balance_delta: '-80', kind: 'EXCHANGE', description: 'Instant order' },
    ],
    w1: [
      { row_index: 1, timestamp: t + 1000, balance_delta: '30', kind: 'EXCHANGE', description: 'Instant order' },
      { row_index: 2, timestamp: t + 21_000, balance_delta: '45', kind: 'EXCHANGE', description: 'Instant order' },
    ],
  };
  const rows = await fetchLunoTransfers({ ...AUTH, pages: 0, fetchImpl: fakeLuno({ wallet, transactions }) });
  assert.deepEqual(rows.map((r) => [r.qty, r.cash_amount]), [[30, 50], [45, 80]]);
});

const noWait = async () => {};
const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

test('transfers: the staking account listed first and without a label is still told apart by its reward rows', async () => {
  const t = 1_760_000_000_000;
  const accounts = [
    { account_id: 'myr1', asset: 'MYR', balance: '0' },
    { account_id: 's1', asset: 'ADA', balance: '10.5' },
    { account_id: 'w1', asset: 'ADA', balance: '100' },
  ];
  const transactions = {
    w1: [{ row_index: 1, timestamp: t, balance_delta: '100', kind: 'EXCHANGE', description: 'Bought 100 ADA for RM 250.00' }],
    s1: [{ row_index: 1, timestamp: t + 86_400_000, balance_delta: '0.5', kind: 'INTEREST', description: 'Staking reward' }],
  };
  const fetchImpl = async (url) => {
    const text = String(url);
    const id = text.match(/accounts\/(\w+)\/transactions/)?.[1];
    if (id) return reply({ transactions: transactions[id] ?? [] });
    // Luno applies the account_type filter. None of these accounts carries a type, so the STAKING query finds nothing.
    if (text.includes('account_type=STAKING') && !text.includes('TRANSACTIONAL')) return reply({ balance: [] });
    return reply({ balance: accounts });
  };
  const rows = await fetchLunoTransfers({ ...AUTH, pages: 0, fetchImpl, wait: noWait });
  assert.deepEqual(rows.map((r) => [r.side, r.qty]).sort(), [['buy', 100], ['staking_reward', 0.5]]);
});

test('transfers: a full read pages through more than 1000 rows of one account', async () => {
  const total = 1005;
  const all = Array.from({ length: total }, (_, i) => ({ row_index: i + 1, timestamp: 1_700_000_000_000 + i * 60_000, balance_delta: '1', kind: 'TRANSFER', description: 'Received' }));
  const requested = [];
  const fetchImpl = async (url) => {
    const text = String(url);
    const match = text.match(/accounts\/(\w+)\/transactions\?min_row=(-?\d+)&max_row=(-?\d+)/);
    if (match) {
      if (match[1] === 'w1') requested.push([Number(match[2]), Number(match[3])]);
      const [min, max] = [Number(match[2]), Number(match[3])];
      return reply({ transactions: match[1] === 'w1' ? all.filter((row) => row.row_index >= min && row.row_index < max) : [] });
    }
    return reply({ balance: wallet });
  };
  const rows = await fetchLunoTransfers({ ...AUTH, pages: 0, fetchImpl, wait: noWait });
  assert.equal(rows.length, total);
  assert.deepEqual(requested, [[1, 1001], [1001, 2001]]);
});

test('transfers: a failed history page is an error, never a shorter history', async () => {
  const fetchImpl = async (url) => {
    const text = String(url);
    if (text.includes('accounts/w1/transactions')) return reply({}, 500);
    return reply({ balance: wallet });
  };
  await assert.rejects(fetchLunoTransfers({ ...AUTH, pages: 0, fetchImpl, wait: noWait }), /status 500/);

  const forbidden = async (url) => (String(url).includes('/transactions') ? reply({}, 403) : reply({ balance: wallet }));
  await assert.rejects(fetchLunoTransfers({ ...AUTH, pages: 0, fetchImpl: forbidden, wait: noWait }), /View transactions/);
});

test('transfers: a rate limit answer (429) is retried and the history is complete', async () => {
  let limited = 2;
  const waits = [];
  const fetchImpl = async (url) => {
    const text = String(url);
    if (text.includes('accounts/w1/transactions')) {
      if (limited > 0) { limited -= 1; return reply({}, 429); }
      return reply({ transactions: [{ row_index: 1, timestamp: 1_700_000_000_000, balance_delta: '5', kind: 'TRANSFER', description: 'Received' }] });
    }
    if (text.includes('/transactions')) return reply({ transactions: [] });
    return reply({ balance: wallet });
  };
  const rows = await fetchLunoTransfers({ ...AUTH, pages: 0, fetchImpl, wait: async (ms) => waits.push(ms) });
  assert.equal(rows.length, 1);
  assert.equal(waits.length, 2, 'one pause for each 429');
});


test('transfers: coins sent to an outside address are a transfer, never a sale, even when Luno shows an RM value', async () => {
  const t = 1_760_000_000_000;
  const transactions = {
    w1: [
      { row_index: 1, timestamp: t, balance_delta: '500', kind: 'EXCHANGE', description: 'Bought 500 ADA for RM 600.00' },
      { row_index: 2, timestamp: t + 60_000, balance_delta: '-174', kind: 'TRANSFER', description: 'Sent Cardano to addr1vy88n0yd', details: { 'Value (MYR)': '496.14' }, detail_fields: { crypto_details: { address: 'addr1vy88n0yd', txid: 'abc' } } },
      { row_index: 3, timestamp: t + 60_000, balance_delta: '-0.310762', kind: 'FEE', description: 'Cardano send fee' },
      // A send that has no crypto_details but says "Sent" and shows an amount is also a transfer.
      { row_index: 4, timestamp: t + 120_000, balance_delta: '-9.37', kind: 'TRANSFER', description: 'Sent Cardano to addr1vy88', details: { amount: '23.89' } },
    ],
  };
  const rows = await fetchLunoTransfers({ ...AUTH, pages: 0, fetchImpl: fakeLuno({ wallet, transactions }), wait: noWait });
  assert.deepEqual(rows.map((r) => [r.external_id, r.side, r.qty, r.cash_amount]), [
    ['luno:inflow:w1:1', 'buy', 500, 600],
    ['luno:transfer:w1:2', 'transfer_to_pionex', 174, 0],
    ['luno:transfer:w1:4', 'transfer_to_pionex', 9.37, 0],
    ['luno:txfee:w1:3', 'send_fee', 0.310762, 0],
  ]);

  // In the ledger the send keeps the Luno average cost and books no profit or loss.
  const imported = planTradeImport({
    trades: rows.map((r) => ({ externalId: r.external_id, broker: r.broker, asset: r.asset, side: r.side, qty: r.qty, cashAmount: r.cash_amount, feeQuote: r.fee_quote, quoteCurrency: 'MYR', tradedAt: Date.parse(r.traded_at) })),
    positions: [], marketPrices: {},
  });
  const luno = imported.positions.find((p) => p.broker === 'Luno' && p.asset === 'ADA');
  assert.equal(luno.realisedPl, 0);
  assert.equal(Number(luno.qty.toFixed(6)), Number((500 - 174 - 9.37 - 0.310762).toFixed(6)));
  assert.equal(luno.costMyr, 379.96, 'the cost of the sent coins left; the fee coins keep their cost');
  const pionex = imported.positions.find((p) => p.broker === 'Pionex' && p.asset === 'ADA');
  assert.equal(pionex.qty, 183.37, 'Pionex receives the sent amount, without the fee');
  assert.equal(pionex.costMyr, 220.04);
});
