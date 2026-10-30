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

// Returns [{ asset, qty }], one row per asset, zero balances left out.
export async function fetchLunoBalances({ keyId, keySecret, fetchImpl = fetch }) {
  const response = await fetchImpl(LUNO_BALANCE_URL, {
    headers: { Authorization: `Basic ${btoa(`${keyId}:${keySecret}`)}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Luno answered with status ${response.status}.`);

  const body = await response.json();
  const totals = new Map();
  for (const account of body.balance ?? []) {
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
// Luno on-chain transfers and account activity:
// - Crypto sent out (e.g. transfer from Luno to Pionex) -> side: 'transfer_to_pionex'
// - Crypto received or instant bought -> side: 'buy'
// API: GET /api/1/accounts/{id}/transactions
// ---------------------------------------------------------------------------

async function getLunoCryptoAccounts({ keyId, keySecret, fetchImpl }) {
  const response = await fetchImpl(LUNO_BALANCE_URL, {
    headers: { Authorization: `Basic ${btoa(`${keyId}:${keySecret}`)}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) return [];
  const body = await response.json();
  const trackedSet = new Set(TRADED_ASSETS);
  const accounts = [];
  for (const entry of body.balance ?? []) {
    const asset = ASSET_NAMES[entry.asset] ?? entry.asset;
    if (trackedSet.has(asset) && entry.account_id) {
      accounts.push({ id: entry.account_id, asset });
    }
  }
  return accounts;
}

export async function fetchLunoTransfers({ keyId, keySecret, fetchImpl = fetch, pages = 1 }) {
  const headers = { Authorization: `Basic ${btoa(`${keyId}:${keySecret}`)}` };
  const rows = [];

  let accounts = [];
  try {
    accounts = await getLunoCryptoAccounts({ keyId, keySecret, fetchImpl });
  } catch {
    return rows;
  }
  if (accounts.length === 0) return rows;

  const unlimited = pages === 0;

  for (const account of accounts) {
    const url = LUNO_TRANSACTIONS_URL_TEMPLATE.replace('{id}', account.id);
    let minRow = unlimited ? 1 : -100;
    let maxRow = unlimited ? 1001 : 0;

    for (;;) {
      const response = await fetchImpl(`${url}?min_row=${minRow}&max_row=${maxRow}`, {
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status === 403 || !response.ok) break;

      const body = await response.json().catch(() => ({}));
      const txns = body.transactions ?? [];

      for (const txn of txns) {
        // Skip exchange trades (already covered by fetchLunoTrades)
        if (txn.detail_fields?.trade_details) continue;
        // Skip fees
        if (txn.kind === 'FEE' || String(txn.description ?? '').toLowerCase().includes('fee')) continue;

        const delta = Number(txn.balance_delta);
        if (!Number.isFinite(delta) || delta === 0) continue;

        const timestamp = Number(txn.timestamp);
        const rowIndex = txn.row_index;

        if (delta < 0) {
          // Outflow: transferred out to Pionex / external wallet
          rows.push({
            external_id: `luno:transfer:${account.id}:${rowIndex}`,
            broker: 'Luno',
            asset: account.asset,
            side: 'transfer_to_pionex',
            qty: Math.abs(delta),
            cash_amount: 0,
            fee_quote: 0,
            quote_currency: 'MYR',
            traded_at: new Date(timestamp).toISOString(),
          });
        } else {
          // Inflow: received or instant buy
          rows.push({
            external_id: `luno:inflow:${account.id}:${rowIndex}`,
            broker: 'Luno',
            asset: account.asset,
            side: 'buy',
            qty: delta,
            cash_amount: 0,
            fee_quote: 0,
            quote_currency: 'MYR',
            traded_at: new Date(timestamp).toISOString(),
          });
        }
      }

      if (!unlimited || txns.length < TRANSACTIONS_PER_PAGE) break;
      minRow += TRANSACTIONS_PER_PAGE;
      maxRow += TRANSACTIONS_PER_PAGE;
    }
  }
  return rows;
}
