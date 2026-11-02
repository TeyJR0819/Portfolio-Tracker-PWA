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
const USER_AGENT = 'portfolio-tracker-worker/1.0';

// Toncoin (TON) was renamed Gram (GRAM) in June 2026. The app keeps the name TON.
const ASSET_NAMES = Object.freeze({ USDT: 'Pionex Cash', GRAM: 'TON' });
// Markets to read for each tracked coin. Older fills may still be listed under the old name.
const MARKET_NAMES = Object.freeze({ TON: ['GRAM', 'TON'] });
const marketList = () => TRADED_ASSETS.flatMap((asset) => (MARKET_NAMES[asset] ?? [asset]).map((market) => [asset, market]));

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
    headers: { 'PIONEX-KEY': apiKey, 'PIONEX-SIGNATURE': signature, 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

// Pionex allows 10 request weight per second per account, and a fills request weighs 5. Requests are
// spaced so the limit is never reached.
const REQUEST_SPACING_MS = 1000;

// What Pionex said with a 429, in a short form for the status line (never contains a key).
async function describeRateLimit(response) {
  const body = (await response.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 100);
  const retryAfter = response.headers.get('retry-after');
  const server = response.headers.get('server');
  return `429${retryAfter ? `, retry after ${retryAfter}s` : ''}${server ? `, from ${server}` : ''}${body ? `, reply: ${body}` : ', no reply text'}`;
}

const defaultWait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

// A 429 can come from the shared address of the Cloudflare Worker, not only from this account, and Pionex bans the
// address or account for 60 seconds. A fast retry only extends the ban, so the one retry waits for the ban to end.
// A Worker run may wait: waiting uses no CPU time.
const RETRY_AFTER_CAP_MS = 65000;
const DEFAULT_BAN_WAIT_MS = 61000;
const MAX_ATTEMPTS = 2;

function banWaitMs(response) {
  const seconds = Number(response.headers.get('retry-after'));
  const asked = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 + 1000 : DEFAULT_BAN_WAIT_MS;
  return Math.min(asked, RETRY_AFTER_CAP_MS);
}

// Pionex says which permission is missing only by a code or a 401/403. Name the setting the user must change.
const PERMISSION_HINT = 'Open the key in Pionex API Management and turn on "Enable reading" (no trading, transfer or withdrawal), and leave the IP allowlist empty.';
function isPermissionProblem(status, body) {
  const code = String(body?.code ?? '').toUpperCase();
  return status === 401 || status === 403 || /PERMISSION|FORBIDDEN|SIGNATURE|API_KEY|APIKEY|UNAUTHORI|IP/.test(code);
}

// After a 429 that survived the retry, one unsigned request to a public endpoint tells whether the whole address is
// blocked (the public endpoint answers 429 too) or only the account is (the public endpoint answers normally).
async function probePublicEndpoint(fetchImpl) {
  try {
    const response = await fetchImpl(`${PIONEX_ORIGIN}/api/v1/common/symbols?symbols=BTC_USDT`, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    return response.status === 429 ? 'a public request is blocked too, so the address of the Worker is limited' : `a public request answers ${response.status}, so only the account or key is limited`;
  } catch {
    return 'the public check could not be made';
  }
}

// One signed GET with at most one retry after a 429. Returns { response, limited, detail }.
async function signedGetWithRetry(request, wait) {
  let detail = '';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const response = await signedGet(request);
    if (response.status !== 429) return { response, limited: false, detail };
    detail = await describeRateLimit(response);
    if (attempt < MAX_ATTEMPTS) await wait(banWaitMs(response));
  }
  return { response: null, limited: true, detail: `${detail}; ${await probePublicEndpoint(request.fetchImpl)}` };
}

export async function fetchPionexBalances({ apiKey, apiSecret, fetchImpl = fetch, now = Date.now, wait = defaultWait }) {
  const { response, limited, detail } = await signedGetWithRetry({ path: BALANCE_PATH, params: {}, apiKey, apiSecret, fetchImpl, now }, wait);
  if (limited) throw new Error(`Pionex rate limit reached (${detail}). It will be tried again in the next run.`);

  const body = await response.json().catch(() => ({}));
  if (isPermissionProblem(response.status, body)) throw new Error(`Pionex refused the key (${body.code ?? response.status}). ${PERMISSION_HINT}`);
  if (!response.ok) throw new Error(`Pionex answered with status ${response.status}.`);
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

// Reads the latest fills of every tracked coin against USDT.
// When pages === 0 (backfill mode), reads ALL pages until Pionex returns a partial page.
// Returns rows for the broker_trades table. When Pionex answers 429, the rows read so far are returned
// with rows.isLimited set, and the rest follows in the next run.
export async function fetchPionexTrades({ apiKey, apiSecret, fetchImpl = fetch, now = Date.now, pages = 1, wait = defaultWait }) {
  const rows = [];
  rows.isLimited = false;
  rows.limitDetail = '';

  const unlimited = pages === 0;

  for (const [asset, market] of marketList()) {
    const symbol = `${market}_USDT`;
    let endTime = null;
    let page = 0;

    for (;;) {
      if (!unlimited && page >= pages) break;
      await wait(REQUEST_SPACING_MS);
      const params = { symbol, ...(endTime ? { endTime } : {}) };
      const { response, limited, detail } = await signedGetWithRetry({ path: FILLS_PATH, params, apiKey, apiSecret, fetchImpl, now }, wait);
      if (limited) {
        rows.isLimited = true;
        rows.limitDetail = detail;
        return rows;
      }
      const body = await response.json().catch(() => ({}));
      if (body.code === 'TRADE_INVALID_SYMBOL') break; // Pionex has no such market.
      if (isPermissionProblem(response.status, body)) throw new Error(`Pionex refused the key for trades (${body.code ?? response.status}). ${PERMISSION_HINT}`);
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
      page += 1;
      if (fills.length < FILLS_PER_PAGE) break;
      endTime = Math.min(...fills.map((fill) => Number(fill.timestamp))) - 1;
    }
  }
  return rows;
}
