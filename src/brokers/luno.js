// Reads Luno balances. The key needs only the "View balance" permission (Perm_R_Balance).
// Luno uses HTTP basic authentication: key ID as user name, key secret as password.
// Trade history needs the "View orders" permission (Perm_R_Orders), which Luno's read-only access includes.

import { TRADED_ASSETS, toTradeRow } from './trades.js';

const LUNO_BALANCE_URL = 'https://api.luno.com/api/1/balance';
const LUNO_TRADES_URL = 'https://api.luno.com/api/1/listtrades';
const REQUEST_TIMEOUT_MS = 10000;
const TRADES_PER_PAGE = 100;

// Luno calls Bitcoin XBT. MYR cash is stored under the ledger name of the cash account.
const ASSET_NAMES = Object.freeze({ XBT: 'BTC', MYR: 'Luno Cash' });

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

// Luno names Bitcoin XBT.
const LUNO_CODES = Object.freeze({ BTC: 'XBT' });

// Reads the latest trades of every tracked coin against MYR. pages > 1 reads further back (first-time import).
// Returns rows for the broker_trades table.
export async function fetchLunoTrades({ keyId, keySecret, fetchImpl = fetch, pages = 1 }) {
  const headers = { Authorization: `Basic ${btoa(`${keyId}:${keySecret}`)}` };
  const rows = [];

  for (const asset of TRADED_ASSETS) {
    const pair = `${LUNO_CODES[asset] ?? asset}MYR`;
    let before = null;

    for (let page = 0; page < pages; page += 1) {
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
          baseQty: Number(trade.volume),
          quoteAmount: Number(trade.counter),
          feeBase: Number(trade.fee_base ?? 0),
          feeQuote: Number(trade.fee_counter ?? 0),
          quoteCurrency: 'MYR',
          tradedAt: Number(trade.timestamp),
        });
        if (row) rows.push(row);
      }
      if (trades.length < TRADES_PER_PAGE) break;
      before = Math.min(...trades.map((trade) => Number(trade.timestamp)));
    }
  }
  return rows;
}
