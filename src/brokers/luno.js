// Reads Luno balances. The key needs only the "View balance" permission (Perm_R_Balance).
// Luno uses HTTP basic authentication: key ID as user name, key secret as password.
// Trade history needs the "View orders" permission (Perm_R_Orders), which Luno's read-only access includes.
// Transfer, Instant Buy and Staking history needs "View transactions" (Perm_R_Transactions) and "View staking" (Perm_R_Staking).

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

const STAKING_ACCOUNT_TYPES = new Set(['STAKING', 'EARN', 'SAVINGS']);

function isStakingAccountEntry(entry) {
  const type = String(entry.account_type ?? '').toUpperCase();
  const name = String(entry.name ?? '').toLowerCase();
  return STAKING_ACCOUNT_TYPES.has(type) || /stak|earn|saving/.test(name);
}

// Total units held in one Luno account: available/balance + reserved ( only if reserved is not already part of balance ) + unconfirmed.
// Per Luno's API spec: `balance` is the account balance and `available` is lower if funds are reserved,
// while on some staking/wallet responses `balance` is available and staked/locked sits in `reserved` or `unconfirmed`.
function parseAccountBalance(entry) {
  const balance = Number(entry.balance ?? 0);
  const unconfirmed = Number(entry.unconfirmed ?? 0);
  const b = Number.isFinite(balance) ? balance : 0;
  const u = Number.isFinite(unconfirmed) ? unconfirmed : 0;
  return b + u;
}

// Luno keeps staked coins in separate STAKING/SAVINGS/EARN accounts.
// Queries default /balance plus explicit account_type filters so every normal and staking wallet is included.
async function fetchBalanceAccounts({ keyId, keySecret, fetchImpl }) {
  const headers = { Authorization: `Basic ${btoa(`${keyId}:${keySecret}`)}` };
  const response = await fetchImpl(LUNO_BALANCE_URL, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Luno answered with status ${response.status}.`);
  const accounts = new Map();
  for (const entry of (await response.json()).balance ?? []) {
    accounts.set(String(entry.account_id ?? `row${accounts.size}`), entry);
  }

  // Also request STAKING, EARN, SAVINGS, TRANSACTIONAL and SPOT explicitly in case /balance omits staking sub-wallets.
  const extraQueries = [
    `${LUNO_BALANCE_URL}?account_type=STAKING`,
    `${LUNO_BALANCE_URL}?account_type=TRANSACTIONAL&account_type=SPOT&account_type=STAKING&account_type=EARN&account_type=SAVINGS`,
  ];
  for (const url of extraQueries) {
    try {
      const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (!res.ok) continue;
      const body = await res.json().catch(() => ({}));
      for (const entry of body.balance ?? []) {
        const id = String(entry.account_id ?? `extra${accounts.size}`);
        const existing = accounts.get(id);
        accounts.set(id, {
          ...existing,
          ...entry,
          account_type: entry.account_type ?? existing?.account_type ?? (url.includes('STAKING') && !url.includes('TRANSACTIONAL') ? 'STAKING' : undefined),
        });
      }
    } catch {
      // Ignore if optional account_type query is unsupported or lacks permission.
    }
  }

  return [...accounts.values()];
}

// Returns [{ asset, qty }], one row per asset (normal wallet + staking wallet added together), zero balances left out.
export async function fetchLunoBalances({ keyId, keySecret, fetchImpl = fetch }) {
  const totals = new Map();
  for (const account of await fetchBalanceAccounts({ keyId, keySecret, fetchImpl })) {
    const asset = ASSET_NAMES[account.asset] ?? account.asset;
    const qty = parseAccountBalance(account);
    if (!Number.isFinite(qty) || qty === 0) continue;
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
// - Instant Buys / Instant Sells (`kind: 'EXCHANGE'` without `trade_details`):
//   Matched with the MYR cash account transactions (by `reference` or timestamp)
//   or parsed from `description` / `details` so the exact RM cost paid (including fee) is recorded!
// - Wallet <-> staking wallet moves of the same coin are the user's own principal.
//   They cancel out and are skipped, so staked principal stays combined with the normal wallet
//   at the normal wallet buying price.
// - Staking rewards (`kind: 'INTEREST'` or reward inflows into staking accounts) ->
//   side 'staking_reward' (bought at RM 0.00).
// - Crypto sent out externally (e.g. to Pionex) -> side 'transfer_to_pionex'.
// ---------------------------------------------------------------------------

const PAIR_WINDOW_MS = 10 * 60 * 1000;
const PAIR_TOLERANCE = 1e-8;
const MYR_MATCH_WINDOW_MS = 60 * 1000;

async function getLunoAccountsForHistory({ keyId, keySecret, fetchImpl }) {
  const trackedSet = new Set(TRADED_ASSETS);
  const allEntries = await fetchBalanceAccounts({ keyId, keySecret, fetchImpl });

  // Count how many accounts exist per crypto asset to detect secondary staking sub-accounts even if account_type is omitted
  const countByAsset = new Map();
  for (const entry of allEntries) {
    const asset = ASSET_NAMES[entry.asset] ?? entry.asset;
    if (trackedSet.has(asset) && entry.account_id) {
      countByAsset.set(asset, (countByAsset.get(asset) ?? 0) + 1);
    }
  }

  const seenByAsset = new Map();
  const cryptoAccounts = [];
  const myrAccounts = [];

  for (const entry of allEntries) {
    if (!entry.account_id) continue;
    if (entry.asset === 'MYR') {
      myrAccounts.push({ id: String(entry.account_id), asset: 'MYR', isStaking: false });
      continue;
    }
    const asset = ASSET_NAMES[entry.asset] ?? entry.asset;
    if (trackedSet.has(asset)) {
      const idx = seenByAsset.get(asset) ?? 0;
      seenByAsset.set(asset, idx + 1);
      const isStaking = isStakingAccountEntry(entry) || (countByAsset.get(asset) > 1 && idx > 0);
      cryptoAccounts.push({ id: String(entry.account_id), asset, isStaking });
    }
  }
  return { cryptoAccounts, myrAccounts };
}

function isRewardText(txn) {
  const kind = String(txn.kind ?? '').toUpperCase();
  if (kind === 'INTEREST' || kind === 'REWARD' || kind === 'STAKING') return true;
  const text = `${txn.kind ?? ''} ${txn.description ?? ''}`.toLowerCase();
  return /reward|interest|yield|payout|distribution/.test(text);
}

function isStakeMoveText(txn) {
  const text = `${txn.kind ?? ''} ${txn.description ?? ''}`.toLowerCase();
  return /stak|unstak|savings|earn/.test(text) && !isRewardText(txn);
}

// Extracts an RM amount from Luno's human-readable description or details map if present
// e.g. "Bought 0.001 BTC for MYR 150.00" or "Sold 10 ADA for RM 25.50"
function parseMyrFromText(txn) {
  const detailsObj = txn.details ?? {};
  for (const [k, v] of Object.entries(detailsObj)) {
    const keyLower = k.toLowerCase();
    if (keyLower.includes('myr') || keyLower.includes('amount') || keyLower.includes('cost') || keyLower.includes('value') || keyLower.includes('counter')) {
      const num = Number(String(v).replace(/[^0-9.-]/g, ''));
      if (Number.isFinite(num) && num > 0) return num;
    }
  }
  const desc = String(txn.description ?? '');
  const match = desc.match(/(?:MYR|RM)\s*([0-9,]+(?:\.[0-9]+)?)/i) ?? desc.match(/([0-9,]+(?:\.[0-9]+)?)\s*(?:MYR|RM)/i);
  if (match) {
    const val = Number(match[1].replace(/,/g, ''));
    if (Number.isFinite(val) && val > 0) return val;
  }
  return 0;
}

// Marks the events that are a coin moving between two accounts of the same user (equal and opposite, or by shared reference).
export function pairOwnMoves(events) {
  const paired = new Set();
  events.forEach((a, i) => {
    if (paired.has(i)) return;
    const j = events.findIndex((b, k) => {
      if (k <= i || paired.has(k)) return false;
      if (a.account.asset !== b.account.asset || a.account.id === b.account.id) return false;
      // Match either by identical Luno reference with opposite sign, or opposite delta within time window
      if (a.txn?.reference && b.txn?.reference && a.txn.reference === b.txn.reference && a.delta * b.delta < 0) {
        return true;
      }
      return Math.abs(a.delta + b.delta) <= PAIR_TOLERANCE && Math.abs(a.timestamp - b.timestamp) <= PAIR_WINDOW_MS;
    });
    if (j >= 0) {
      paired.add(i);
      paired.add(j);
    }
  });
  return paired;
}

function classifyEvent({ account, txn, delta }, matchedMyrAmount = 0) {
  if (delta > 0 && (isRewardText(txn) || (account.isStaking && !isStakeMoveText(txn)))) return 'staking_reward';
  if (account.isStaking || isStakeMoveText(txn)) return null; // principal moving in or out of staking
  const isExchange = String(txn.kind ?? '').toUpperCase() === 'EXCHANGE' || matchedMyrAmount > 0 || parseMyrFromText(txn) > 0;
  if (delta < 0) {
    // If MYR arrived for this outflow (or kind === EXCHANGE), it's an Instant Sell, not a transfer to Pionex!
    return isExchange ? 'sell' : 'transfer_to_pionex';
  }
  return 'buy';
}

async function fetchAccountTransactions(accountId, headers, fetchImpl, unlimited) {
  const url = LUNO_TRANSACTIONS_URL_TEMPLATE.replace('{id}', accountId);
  // Always read from row 1 if unlimited, or latest 1000 rows so early Instant Buys are never missed!
  let minRow = unlimited ? 1 : -1000;
  let maxRow = unlimited ? 1001 : 0;
  const allTxns = [];

  for (;;) {
    const response = await fetchImpl(`${url}?min_row=${minRow}&max_row=${maxRow}`, {
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status === 403 || !response.ok) break;

    const txns = (await response.json().catch(() => ({}))).transactions ?? [];
    allTxns.push(...txns);

    if (!unlimited || txns.length < TRANSACTIONS_PER_PAGE) break;
    minRow += TRANSACTIONS_PER_PAGE;
    maxRow += TRANSACTIONS_PER_PAGE;
  }
  return allTxns;
}

export async function fetchLunoTransfers({ keyId, keySecret, fetchImpl = fetch, pages = 1 }) {
  const headers = { Authorization: `Basic ${btoa(`${keyId}:${keySecret}`)}` };
  let cryptoAccounts = [];
  let myrAccounts = [];

  try {
    ({ cryptoAccounts, myrAccounts } = await getLunoAccountsForHistory({ keyId, keySecret, fetchImpl }));
  } catch {
    return [];
  }
  if (cryptoAccounts.length === 0) return [];

  const unlimited = pages === 0;

  // Read MYR cash account transactions so Instant Buy / Instant Sell MYR amounts & fees can be matched accurately
  const myrByReference = new Map(); // reference -> { totalMyr, feeMyr, timestamp }
  const myrEvents = []; // [{ delta, isFee, timestamp, reference, used }]

  for (const myrAcc of myrAccounts) {
    const txns = await fetchAccountTransactions(myrAcc.id, headers, fetchImpl, unlimited);
    for (const txn of txns) {
      if (txn.detail_fields?.trade_details) continue;
      const delta = Number(txn.balance_delta);
      if (!Number.isFinite(delta) || delta === 0) continue;
      const isFee = txn.kind === 'FEE' || String(txn.description ?? '').toLowerCase().includes('fee');
      const timestamp = Number(txn.timestamp);
      const ref = txn.reference ? String(txn.reference) : '';

      if (ref) {
        const group = myrByReference.get(ref) ?? { totalMyr: 0, feeMyr: 0, timestamp };
        group.totalMyr += Math.abs(delta);
        if (isFee) group.feeMyr += Math.abs(delta);
        myrByReference.set(ref, group);
      }
      myrEvents.push({ delta, isFee, timestamp, reference: ref, used: false });
    }
  }

  const events = [];
  for (const account of cryptoAccounts) {
    const txns = await fetchAccountTransactions(account.id, headers, fetchImpl, unlimited);

    // Group fees on the crypto side by reference or timestamp so crypto-denominated Instant Buy fees are accounted for
    const cryptoFeeByRef = new Map();
    for (const txn of txns) {
      const isFee = txn.kind === 'FEE' || String(txn.description ?? '').toLowerCase().includes('fee');
      if (isFee && txn.reference) {
        const d = Math.abs(Number(txn.balance_delta) || 0);
        cryptoFeeByRef.set(txn.reference, (cryptoFeeByRef.get(txn.reference) ?? 0) + d);
      }
    }

    for (const txn of txns) {
      if (txn.detail_fields?.trade_details) continue; // Exchange order-book trades come from fetchLunoTrades
      if (txn.kind === 'FEE' || String(txn.description ?? '').toLowerCase().includes('fee')) continue;
      const rawDelta = Number(txn.balance_delta);
      if (!Number.isFinite(rawDelta) || rawDelta === 0) continue;

      // If Luno deducted a separate FEE row in the crypto account with the same reference on an instant buy, net it
      const refFee = txn.reference ? (cryptoFeeByRef.get(txn.reference) ?? 0) : 0;
      const netDelta = rawDelta > 0 && refFee > 0 && refFee < rawDelta ? rawDelta - refFee : rawDelta;

      events.push({
        account,
        txn,
        delta: netDelta,
        rawDelta,
        timestamp: Number(txn.timestamp),
        rowIndex: txn.row_index,
      });
    }
  }

  const paired = pairOwnMoves(events);
  const rows = [];

  events.forEach((event, index) => {
    if (paired.has(index)) return;
    const { account, txn, delta, timestamp, rowIndex } = event;

    // Find matching MYR cash movement for Instant Buy / Instant Sell
    let cashAmount = 0;
    let feeQuote = 0;
    const ref = txn.reference ? String(txn.reference) : '';

    if (ref && myrByReference.has(ref)) {
      const match = myrByReference.get(ref);
      cashAmount = match.totalMyr;
      feeQuote = match.feeMyr;
    } else if (String(txn.kind ?? '').toUpperCase() === 'EXCHANGE' || /bought|sold|instant/i.test(String(txn.description ?? ''))) {
      // Match MYR entries within 60 seconds with opposite direction
      const candidates = myrEvents.filter(
        (m) => !m.used && Math.abs(m.timestamp - timestamp) <= MYR_MATCH_WINDOW_MS && (delta > 0 ? m.delta < 0 : m.delta > 0),
      );
      if (candidates.length > 0) {
        for (const c of candidates) {
          c.used = true;
          cashAmount += Math.abs(c.delta);
          if (c.isFee) feeQuote += Math.abs(c.delta);
        }
      }
    }

    if (cashAmount <= 0) {
      cashAmount = parseMyrFromText(txn);
    }

    const side = classifyEvent(event, cashAmount);
    if (!side) return;

    const idPrefix = side === 'staking_reward' ? 'reward' : side === 'buy' || side === 'sell' ? 'inflow' : 'transfer';
    rows.push({
      external_id: `luno:${idPrefix}:${account.id}:${rowIndex}`,
      broker: 'Luno',
      asset: account.asset,
      side,
      qty: Number(Math.abs(delta).toFixed(8)),
      cash_amount: Number(cashAmount.toFixed(2)),
      fee_quote: Number(feeQuote.toFixed(2)),
      quote_currency: 'MYR',
      traded_at: new Date(timestamp).toISOString(),
    });
  });

  return rows;
}
