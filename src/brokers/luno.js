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
const HISTORY_RETRIES = 5; // Luno allows 300 calls a minute. A 429 or a 5xx answer is retried, never skipped.
const RETRY_DELAY_MS = 2000;
const defaultWait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

// The side of the USER's order. Luno's `type` is the type of the order the user placed (BID = buy, ASK = sell).
// `is_buy` describes the other party, the market taker: for a limit order that rested in the book it says the
// opposite of what the user did. Reading `is_buy` first turned many buys into sells, so the ledger ended with no coins.
function tradeSide(trade) {
  const type = String(trade.type ?? '').toUpperCase();
  if (type === 'BID') return 'buy';
  if (type === 'ASK') return 'sell';
  return trade.is_buy ? 'buy' : 'sell';
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
          side: tradeSide(trade),
          baseQty: Number(trade.base ?? trade.volume),
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

// Lists the crypto and MYR accounts to read. An account is a staking account only when Luno says so
// (account_type or name). The old guess "the second account of a coin is the staking one" depended on the order
// of Luno's answer: when the staking account came first, the normal wallet was read as staking and every Instant Buy
// in it was booked as a RM 0.00 reward. The content check in markStakingByContent replaces that guess.
async function getLunoAccountsForHistory({ keyId, keySecret, fetchImpl }) {
  const trackedSet = new Set(TRADED_ASSETS);
  const allEntries = await fetchBalanceAccounts({ keyId, keySecret, fetchImpl });

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
      cryptoAccounts.push({ id: String(entry.account_id), asset, isStaking: isStakingAccountEntry(entry) });
    }
  }
  return { cryptoAccounts, myrAccounts };
}

// When a coin has several accounts and Luno did not label any of them as staking, the account that holds the
// interest payments is the staking account. Only reward words count here: the normal wallet also says "Staked to ...".
function markStakingByContent(cryptoAccounts, historyByAccount) {
  const byAsset = new Map();
  for (const account of cryptoAccounts) byAsset.set(account.asset, [...(byAsset.get(account.asset) ?? []), account]);
  for (const accounts of byAsset.values()) {
    if (accounts.length < 2 || accounts.some((account) => account.isStaking)) continue;
    for (const account of accounts) {
      const paysRewards = (historyByAccount.get(account.id) ?? []).some(
        (txn) => Number(txn.balance_delta) > 0 && (String(txn.kind ?? '').toUpperCase() === 'INTEREST' || /reward|interest/i.test(String(txn.description ?? ''))),
      );
      if (paysRewards) account.isStaking = true;
    }
  }
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

// A coin sent to an outside address (for example to Pionex). Luno shows the RM value of the coins in the description or
// details of such a row. That value is only a label: no MYR arrived, so it is not a sale. Reading it as one booked a
// false sale at that price, with a realised loss, and removed the cost of the coins.
function isCryptoSend(txn) {
  if (txn.detail_fields?.crypto_details) return true;
  if (String(txn.kind ?? '').toUpperCase() === 'EXCHANGE') return false;
  return /\b(sent|send|withdraw|withdrawal)\b/i.test(String(txn.description ?? ''));
}

// The fee Luno takes for sending a coin out, for example "Cardano send fee".
function isSendFeeText(txn) {
  const text = String(txn.description ?? '').toLowerCase();
  return text.includes('fee') && /\b(send|sent|withdraw\w*)\b/.test(text);
}

function classifyEvent({ account, txn, delta }, matchedMyrAmount = 0) {
  if (delta > 0 && (isRewardText(txn) || (account.isStaking && !isStakeMoveText(txn)))) return 'staking_reward';
  if (account.isStaking || isStakeMoveText(txn)) return null; // principal moving in or out of staking
  if (delta < 0) {
    if (isCryptoSend(txn)) return 'transfer_to_pionex';
    // Only a real exchange (MYR arrived, or Luno calls it an exchange) is an Instant Sell.
    const isExchange = String(txn.kind ?? '').toUpperCase() === 'EXCHANGE' || matchedMyrAmount > 0;
    return isExchange ? 'sell' : 'transfer_to_pionex';
  }
  return 'buy';
}

// One Luno request. A 429 (rate limit) or 5xx answer is retried with a growing pause, so a busy minute never
// leaves a hole in the history. Any other failure is thrown and names the status.
async function getWithRetry(url, headers, fetchImpl, wait) {
  for (let attempt = 1; ; attempt += 1) {
    const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt >= HISTORY_RETRIES) return response;
    await wait(RETRY_DELAY_MS * attempt);
  }
}

// Reads the movements of one account. Backfill (unlimited) reads from row 1 upward, 1000 rows at a time, until a page is
// not full. A normal run reads only the newest 1000 rows.
// A failed page is an error. It used to stop silently and return only what was read so far. That partial list then
// looked like the complete history, so the sync deleted the older rows and the ledger lost staking rewards.
async function fetchAccountTransactions(accountId, headers, fetchImpl, unlimited, wait) {
  const url = LUNO_TRANSACTIONS_URL_TEMPLATE.replace('{id}', accountId);
  let minRow = unlimited ? 1 : -TRANSACTIONS_PER_PAGE;
  let maxRow = unlimited ? 1 + TRANSACTIONS_PER_PAGE : 0;
  const byRow = new Map();

  for (;;) {
    const response = await getWithRetry(`${url}?min_row=${minRow}&max_row=${maxRow}`, headers, fetchImpl, wait);
    if (response.status === 403) {
      throw new Error('Luno refused the account history (403). The key needs "View transactions" and "View staking".');
    }
    if (!response.ok) throw new Error(`Luno answered with status ${response.status} for the account history.`);

    const body = await response.json().catch(() => null);
    if (!body || !Array.isArray(body.transactions ?? [])) throw new Error('Luno sent an account history that could not be read.');
    const txns = body.transactions ?? [];
    for (const txn of txns) byRow.set(`${txn.row_index}`, txn);

    if (!unlimited || txns.length < TRANSACTIONS_PER_PAGE) break;
    minRow += TRANSACTIONS_PER_PAGE;
    maxRow += TRANSACTIONS_PER_PAGE;
  }
  return [...byRow.values()];
}

export async function fetchLunoTransfers({ keyId, keySecret, fetchImpl = fetch, pages = 1, wait = defaultWait }) {
  const headers = { Authorization: `Basic ${btoa(`${keyId}:${keySecret}`)}` };
  let cryptoAccounts = [];
  let myrAccounts = [];

  // A failure here is thrown to the caller. Returning an empty list would look like "no history" and delete the saved rows.
  ({ cryptoAccounts, myrAccounts } = await getLunoAccountsForHistory({ keyId, keySecret, fetchImpl }));
  if (cryptoAccounts.length === 0) return [];

  const unlimited = pages === 0;

  // Read MYR cash account transactions so Instant Buy / Instant Sell MYR amounts & fees can be matched accurately
  const myrByReference = new Map(); // reference -> { totalMyr, feeMyr, timestamp }
  const myrEvents = []; // [{ delta, isFee, timestamp, reference, used }]

  for (const myrAcc of myrAccounts) {
    const txns = await fetchAccountTransactions(myrAcc.id, headers, fetchImpl, unlimited, wait);
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

  // Read every account first, so a staking account without a label can be recognised before any movement is classified.
  const historyByAccount = new Map();
  for (const account of cryptoAccounts) {
    historyByAccount.set(account.id, await fetchAccountTransactions(account.id, headers, fetchImpl, unlimited, wait));
  }
  markStakingByContent(cryptoAccounts, historyByAccount);

  const events = [];
  const feeRows = [];
  for (const account of cryptoAccounts) {
    const txns = historyByAccount.get(account.id);

    // Group fees on the crypto side by reference or timestamp so crypto-denominated Instant Buy fees are accounted for
    const cryptoFeeByRef = new Map();
    for (const txn of txns) {
      const isFee = txn.kind === 'FEE' || String(txn.description ?? '').toLowerCase().includes('fee');
      if (isFee && txn.reference) {
        const d = Math.abs(Number(txn.balance_delta) || 0);
        cryptoFeeByRef.set(txn.reference, (cryptoFeeByRef.get(txn.reference) ?? 0) + d);
      }
    }

    // The network fee of a send ("Cardano send fee") is its own row. The fee coins leave Luno, but their cost stays.
    if (!account.isStaking) {
      for (const txn of txns) {
        const delta = Number(txn.balance_delta);
        if (!Number.isFinite(delta) || delta >= 0 || txn.detail_fields?.trade_details) continue;
        if (!isSendFeeText(txn)) continue;
        feeRows.push({
          external_id: `luno:txfee:${account.id}:${txn.row_index}`, broker: 'Luno', asset: account.asset, side: 'send_fee',
          qty: Number(Math.abs(delta).toFixed(8)), cash_amount: 0, fee_quote: 0, quote_currency: 'MYR',
          traded_at: new Date(Number(txn.timestamp)).toISOString(),
        });
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
      // Match one MYR movement within 60 seconds in the opposite direction (the closest one), plus its own fee rows.
      // Taking every movement in the window would merge two instant buys made close together.
      const candidates = myrEvents.filter(
        (m) => !m.used && !m.isFee && Math.abs(m.timestamp - timestamp) <= MYR_MATCH_WINDOW_MS && (delta > 0 ? m.delta < 0 : m.delta > 0),
      );
      candidates.sort((a, b) => Math.abs(a.timestamp - timestamp) - Math.abs(b.timestamp - timestamp));
      const main = candidates[0];
      if (main) {
        main.used = true;
        cashAmount += Math.abs(main.delta);
        for (const fee of myrEvents) {
          if (fee.used || !fee.isFee || Math.abs(fee.timestamp - main.timestamp) > 5000) continue;
          fee.used = true;
          cashAmount += delta > 0 ? Math.abs(fee.delta) : -Math.abs(fee.delta);
          feeQuote += Math.abs(fee.delta);
        }
      }
    }

    const isSend = delta < 0 && isCryptoSend(txn);
    if (isSend) cashAmount = 0; // a send has no MYR amount
    else if (cashAmount <= 0) cashAmount = parseMyrFromText(txn);

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

  return [...rows, ...feeRows];
}
