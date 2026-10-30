// Reads Pionex trading-account balances and trade fills. Create the key with "Read" permission only.
// Bot and earn balances are not part of this endpoint, which matches the app's rules.
//
// Signing (from the Pionex documentation): HMAC SHA256, hex encoded, over
//   METHOD + path + "?" + query pairs sorted by key (timestamp included).
// The signature goes in PIONEX-SIGNATURE. The key goes in PIONEX-KEY.

import { TRADED_ASSETS, toTradeRow } from './trades.js';

const PIONEX_ORIGIN = 'https://api.pionex.com';
const BALANCE_PATH = '/api/v1/account/balances';
const FILLS_PATH = '/api/v1/trade/fills';
const FILLS_PER_PAGE = 100; // Pionex returns at most the latest 100 fills per request.
const REQUEST_TIMEOUT_MS = 10000;

const ASSET_NAMES = Object.freeze({ USDT: 'Pionex Cash' });

export async function sign(secret, message) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

// One signed GET request. The signed text is METHOD + path + "?" + the query pairs sorted by key.
async function signedGet({ path, params, apiKey, apiSecret, fetchImpl, now }) {
  const timestamp = typeof now === 'function' ? now() : now;
  const query = Object.entries({ ...params, timestamp })
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
  const signature = await sign(apiSecret, `GET${path}?${query}`);
  return fetchImpl(`${PIONEX_ORIGIN}${path}?${query}`, {
    headers: { 'PIONEX-KEY': apiKey, 'PIONEX-SIGNATURE': signature },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

// Pionex allows 10 request weight per second per account, and a fills request weighs 5. Requests are
// spaced so the limit is never reached. After a 429 Pionex bans the account for 60 seconds, and every
// further request during the ban makes it longer, so the code stops instead of retrying.
const REQUEST_SPACING_MS = 700;
const defaultWait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function fetchPionexBalances({ apiKey, apiSecret, fetchImpl = fetch, now = Date.now }) {
  const response = await signedGet({ path: BALANCE_PATH, params: {}, apiKey, apiSecret, fetchImpl, now });
  if (response.status === 429) throw new Error('Pionex rate limit reached (429). It will be tried again in the next run.');
  if (!response.ok) throw new Error(`Pionex answered with status ${response.status}.`);

  const body = await response.json();
  if (body.result === false) throw new Error(`Pionex refused the request (${body.code ?? 'no code'}).`);

  const totals = new Map();
  for (const entry of body.data?.balances ?? []) {
    const asset = ASSET_NAMES[entry.coin] ?? entry.coin;
    const qty = Number(entry.free) + Number(entry.frozen);
    if (!Number.isFinite(qty)) continue;
    totals.set(asset, (totals.get(asset) ?? 0) + qty);
  }
  return [...totals].filter(([, qty]) => qty !== 0).map(([asset, qty]) => ({ asset, qty }));
}

// Reads the latest fills of every tracked coin against USDT. pages > 1 reads further back (first-time import).
// Returns rows for the broker_trades table. When Pionex answers 429, the rows read so far are returned
// with rows.isLimited set, and the rest follows in the next run.
export async function fetchPionexTrades({ apiKey, apiSecret, fetchImpl = fetch, now = Date.now, pages = 1, wait = defaultWait }) {
  const rows = [];
  rows.isLimited = false;

  for (const asset of TRADED_ASSETS) {
    const symbol = `${asset}_USDT`;
    let endTime = null;

    for (let page = 0; page < pages; page += 1) {
      await wait(REQUEST_SPACING_MS);
      const params = { symbol, ...(endTime ? { endTime } : {}) };
      const response = await signedGet({ path: FILLS_PATH, params, apiKey, apiSecret, fetchImpl, now });
      if (response.status === 429) {
        rows.isLimited = true;
        return rows;
      }
      const body = await response.json().catch(() => ({}));
      if (body.code === 'TRADE_INVALID_SYMBOL') break; // Pionex has no such market.
      if (!response.ok) throw new Error(`Pionex answered with status ${response.status} for trades.`);
      if (body.result === false) throw new Error(`Pionex refused the trade request (${body.code ?? 'no code'}).`);

      const fills = body.data?.fills ?? [];
      for (const fill of fills) {
        const baseQty = Number(fill.size);
        const fee = Number(fill.fee ?? 0);
        const row = toTradeRow({
          externalId: `pionex:${fill.id}`,
          broker: 'Pionex',
          asset,
          side: String(fill.side).toUpperCase() === 'BUY' ? 'buy' : 'sell',
          baseQty,
          quoteAmount: baseQty * Number(fill.price),
          feeBase: fill.feeCoin === asset ? fee : 0,
          feeQuote: fill.feeCoin === 'USDT' ? fee : 0, // A fee in any other coin (for example a platform token) is not counted.
          quoteCurrency: 'USDT',
          tradedAt: Number(fill.timestamp),
        });
        if (row) rows.push(row);
      }
      if (fills.length < FILLS_PER_PAGE) break;
      endTime = Math.min(...fills.map((fill) => Number(fill.timestamp))) - 1;
    }
  }
  return rows;
}
