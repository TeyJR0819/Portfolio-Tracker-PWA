import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fetchLunoBalances, fetchLunoTransfers, pairOwnMoves } from '../src/brokers/luno.js';
import { getTradableAssetsForBroker, getCashAssetForBroker } from '../public/js/logic/catalog.js';

const AUTH = { keyId: 'id', keySecret: 'secret' };
const json = (body) => ({ ok: true, status: 200, json: async () => body });

function fakeLuno({ wallet, staking, transactions }) {
  return async (url) => {
    const text = String(url);
    if (text.includes('/balance?account_type=STAKING')) return json({ balance: staking });
    if (text.endsWith('/balance')) return json({ balance: wallet });
    const id = text.match(/accounts\/(\w+)\/transactions/)?.[1];
    return json({ transactions: transactions[id] ?? [] });
  };
}

const wallet = [{ account_id: 'w1', asset: 'ADA', balance: '100', account_type: 'TRANSACTIONAL' }];
const staking = [{ account_id: 's1', asset: 'ADA', balance: '50.5', account_type: 'STAKING' }];

test('balances: the staking wallet is added to the normal wallet', async () => {
  const rows = await fetchLunoBalances({ ...AUTH, fetchImpl: fakeLuno({ wallet, staking, transactions: {} }) });
  assert.deepEqual(rows, [{ asset: 'ADA', qty: 150.5 }]);
});

test('transfers: principal moves cancel out and only the reward is recorded', async () => {
  const t = 1_760_000_000_000;
  const transactions = {
    w1: [{ row_index: 1, timestamp: t, balance_delta: '-50', kind: 'TRANSFER', description: 'Staked to ADA Staking Wallet' }],
    s1: [
      { row_index: 1, timestamp: t + 1000, balance_delta: '50', kind: 'TRANSFER', description: 'Staked' },
      { row_index: 2, timestamp: t + 86_400_000, balance_delta: '0.5', kind: 'REWARD', description: 'Staking reward' },
    ],
  };
  const rows = await fetchLunoTransfers({ ...AUTH, pages: 0, fetchImpl: fakeLuno({ wallet, staking, transactions }) });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].side, 'staking_reward');
  assert.equal(rows[0].qty, 0.5);
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
