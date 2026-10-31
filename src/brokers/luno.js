// Reads Luno balances. The key needs only the "View balance" permission (Perm_R_Balance).
// Luno uses HTTP basic authentication: key ID as user name, key secret as password.
// Trade history needs the "View orders" permission (Perm_R_Orders), which Luno's read-only access includes.
// Transfer and transaction history needs "View transactions" (Perm_R_Transactions).

import { TRADED_ASSETS, toTradeRow } from './trades.js';

const LUNO_BALANCE_URL = 'https://api.luno.com/api/1/balance';
const LUNO_TRADES_URL = 'https://api.luno.com/api/1/listtrades';
const LUNO_TRANSACTIONS_URL_TEMPLATE = 'https://api.luno.com/api/1/accounts/{id}/transactions';
const REQUEST_TIMEOUT_MS = 10000;
const TRADES_PER_PAGE = 100;
const TRANSACTIONS_PER_PAGE = 1000;

// Luno calls Bitcoin XBT. MYR cash is stored under the ledger name of the cash account.
const ASSET_NAMES = Object.freeze({ XBT: 'BTC', MYR: 'Luno Cash' });
const LUNO_CODES = Object.freeze({ BTC: 'XBT' });

// Luno keeps staked coins in separate STAKING accounts. /balance lists only the normal accounts unless the
// account type is asked for, so both lists are read and merged by account id.
async function fetchBalanceAccounts({ keyId, keySecret, fetchImpl }) {
  const headers = { Authorization: `Basic ${btoa(`${keyId}:${keySecret}`)}` };
  const response = await fetchImpl(LUNO_BALANCE_URL, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Luno answered with status ${response.status}.`);
  const accounts = new Map();
  for (const entry of (await response.json()).balance ?? []) accounts.set(entry.account_id ?? `row${accounts.size}`, entry);

  try {
    const staking = await fetchImpl(`${LUNO_BALANCE_URL}?account_type=STAKING`, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (staking.ok) {
      for (const entry of (await staking.json()).balance ?? []) {
        accounts.set(entry.account_id ?? `staking${accounts.size}`, { ...entry, account_type: entry.account_type ?? 'STAKING' });
      }
    }
  } catch {
    // Without the "View staking" permission only the normal wallet is counted.
  }
  return [...accounts.values()];
}

// Returns [{ asset, qty }], one row per asset (normal wallet + staking wallet added together), zero balances left out.
export async function fetchLunoBalances({ keyId, keySecret, fetchImpl = fetch }) {
  const totals = new Map();
  for (const account of await fetchBalanceAccounts({ keyId, keySecret, fetchImpl })) {
    const asset = ASSET_NAMES[account.asset] ?? account.asset;
    const qty = Number(account.balance);
    if (!Number.isFinite(qty)) continue;
    totals.set(asset, (totals.get(asset) ?? 0) + qty);
  }
  return [...totals].filter(([, qty]) => qty !== 0).map(([asset, qty]) => ({ asset, qty }));
}

// Reads the latest trades of every tracked coin against MYR.
// pages === 0 (backfill mode) reads until Luno has no more trades.
export async function fetchLunoTrades({ keyId, keySecret, fetchImpl = fetch, pages = 1 }) {
  const headers = { Authorization: `Basic ${btoa(`${keyId}:${keySecret}`)}` };
  const rows = [];
  const unlimited = pages === 0;

  for (const asset of TRADED_ASSETS) {
    const pair = `${LUNO_CODES[asset] ?? asset}MYR`;
    let before = null;
    let page = 0;

    for (;;) {
      if (!unlimited && page >= pages) break;
      const query = `pair=${pair}&limit=${TRADES_PER_PAGE}&sort_desc=true${before ? `&before=${before}` : ''}`;
      const response = await fetchImpl(`${LUNO_TRADES_URL}?${query}`, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (response.status === 400 || response.status === 404) break; // Luno has no such pair.
      if (!response.ok) throw new Error(`Luno answered with status ${response.status} for trades.`);

      const trades = (await response.json()).trades ?? [];
      for (const trade of trades) {
        const row = toTradeRow({
          externalId: `luno:${pair}:${trade.sequence}`,
          broker: 'Luno',
          asset,
          side: trade.is_buy === undefined ? (trade.type === 'BID' ? 'buy' : 'sell') : trade.is_buy ? 'buy' : 'sell',
          baseQty: Number(trade.volume ?? trade.base),
          quoteAmount: Number(trade.counter),
          feeBase: Number(trade.fee_base ?? 0),
          feeQuote: Number(trade.fee_counter ?? 0),
          quoteCurrency: 'MYR',
          tradedAt: Number(trade.timestamp),
        });
        if (row) rows.push(row);
      }
      page += 1;
      if (trades.length < TRADES_PER_PAGE) break;
      const minTimestamp = Math.min(...trades.map((trade) => Number(trade.timestamp)));
      if (!Number.isFinite(minTimestamp) || minTimestamp <= 0) break;
      before = minTimestamp;
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Luno account movements (GET /api/1/accounts/{id}/transactions):
// - Wallet <-> staking wallet moves of the same coin are the user's own principal. They cancel out and are skipped,
//   so the staked coins stay in the Luno balance at the buying price of the normal wallet.
// - Other money arriving in a staking account is a staking reward -> side 'staking_reward' (cost RM 0.00).
// - Crypto sent out (for example to Pionex) -> side 'transfer_to_pionex'.
// - Crypto received -> side 'buy' with no cost (priced at the market by the importer).
// ---------------------------------------------------------------------------

const PAIR_WINDOW_MS = 10 * 60 * 1000;
const PAIR_TOLERANCE = 1e-8;

async function getLunoCryptoAccounts({ keyId, keySecret, fetchImpl }) {
  const trackedSet = new Set(TRADED_ASSETS);
  const accounts = [];
  for (const entry of await fetchBalanceAccounts({ keyId, keySecret, fetchImpl })) {
    const asset = ASSET_NAMES[entry.asset] ?? entry.asset;
    if (trackedSet.has(asset) && entry.account_id) {
      accounts.push({ id: entry.account_id, asset, isStaking: String(entry.account_type ?? '').toUpperCase() === 'STAKING' });
    }
  }
  return accounts;
}

function isRewardText(txn) {
  const text = `${txn.kind ?? ''} ${txn.description ?? ''}`.toLowerCase();
  return /reward|interest|yield|payout/.test(text);
}

function isStakeMoveText(txn) {
  return /stak|unstak/.test(`${txn.kind ?? ''} ${txn.description ?? ''}`.toLowerCase());
}

// Marks the events that are a coin moving between two accounts of the same user (equal and opposite, close in time).
export function pairOwnMoves(events) {
  const paired = new Set();
  events.forEach((a, i) => {
    if (paired.has(i)) return;
    const j = events.findIndex((b, k) => k > i && !paired.has(k)
      && a.account.asset === b.account.asset && a.account.id !== b.account.id
      && Math.abs(a.delta + b.delta) <= PAIR_TOLERANCE && Math.abs(a.timestamp - b.timestamp) <= PAIR_WINDOW_MS);
    if (j >= 0) { paired.add(i); paired.add(j); }
  });
  return paired;
}

function classifyEvent({ account, txn, delta }) {
  if (delta > 0 && (isRewardText(txn) || (account.isStaking && !isStakeMoveText(txn)))) return 'staking_reward';
  if (account.isStaking || isStakeMoveText(txn)) return null; // principal moving in or out of staking
  return delta < 0 ? 'transfer_to_pionex' : 'buy';
}

export async function fetchLunoTransfers({ keyId, keySecret, fetchImpl = fetch, pages = 1 }) {
  const headers = { Authorization: `Basic ${btoa(`${keyId}:${keySecret}`)}` };
  const events = [];

  let accounts = [];
  try {
    accounts = await getLunoCryptoAccounts({ keyId, keySecret, fetchImpl });
  } catch {
    return [];
  }

  const unlimited = pages === 0;
  for (const account of accounts) {
    const url = LUNO_TRANSACTIONS_URL_TEMPLATE.replace('{id}', account.id);
    let minRow = unlimited ? 1 : -100;
    let maxRow = unlimited ? 1001 : 0;

    for (;;) {
      const response = await fetchImpl(`${url}?min_row=${minRow}&max_row=${maxRow}`, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (response.status === 403 || !response.ok) break;

      const txns = (await response.json().catch(() => ({}))).transactions ?? [];
      for (const txn of txns) {
        if (txn.detail_fields?.trade_details) continue; // exchange trades come from fetchLunoTrades
        if (txn.kind === 'FEE' || String(txn.description ?? '').toLowerCase().includes('fee')) continue;
        const delta = Number(txn.balance_delta);
        if (!Number.isFinite(delta) || delta === 0) continue;
        events.push({ account, txn, delta, timestamp: Number(txn.timestamp), rowIndex: txn.row_index });
      }

      if (!unlimited || txns.length < TRANSACTIONS_PER_PAGE) break;
      minRow += TRANSACTIONS_PER_PAGE;
      maxRow += TRANSACTIONS_PER_PAGE;
    }
  }

  const paired = pairOwnMoves(events);
  const rows = [];
  events.forEach((event, index) => {
    if (paired.has(index)) return;
    const side = classifyEvent(event);
    if (!side) return;
    const { account, delta, timestamp, rowIndex } = event;
    const idPrefix = side === 'staking_reward' ? 'reward' : side === 'buy' ? 'inflow' : 'transfer';
    rows.push({
      external_id: `luno:${idPrefix}:${account.id}:${rowIndex}`,
      broker: 'Luno',
      asset: account.asset,
      side,
      qty: Math.abs(delta),
      cash_amount: 0,
      fee_quote: 0,
      quote_currency: 'MYR',
      traded_at: new Date(timestamp).toISOString(),
    });
  });
  return rows;
}
