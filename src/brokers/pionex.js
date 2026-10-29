// Reads Pionex trading-account balances. Create the key with "Read" permission only.
// Bot and earn balances are not part of this endpoint, which matches the app's rules.
//
// Signing (from the Pionex documentation): HMAC SHA256, hex encoded, over
//   METHOD + path + "?" + query pairs sorted by key (timestamp included).
// The signature goes in PIONEX-SIGNATURE. The key goes in PIONEX-KEY.

const PIONEX_ORIGIN = 'https://api.pionex.com';
const BALANCE_PATH = '/api/v1/account/balances';
const REQUEST_TIMEOUT_MS = 10000;

const ASSET_NAMES = Object.freeze({ USDT: 'Pionex Cash' });

export async function sign(secret, message) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function fetchPionexBalances({ apiKey, apiSecret, fetchImpl = fetch, now = Date.now() }) {
  const query = `timestamp=${now}`;
  const signature = await sign(apiSecret, `GET${BALANCE_PATH}?${query}`);

  const response = await fetchImpl(`${PIONEX_ORIGIN}${BALANCE_PATH}?${query}`, {
    headers: { 'PIONEX-KEY': apiKey, 'PIONEX-SIGNATURE': signature },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
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
