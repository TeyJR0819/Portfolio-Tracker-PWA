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
  assert.deepEqual(names.sort(), ['QQQM', 'SPYL', 'VOO', 'Webull Cash']);
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
