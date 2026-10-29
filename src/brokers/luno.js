// Reads Luno balances. The key needs only the "View balance" permission (Perm_R_Balance).
// Luno uses HTTP basic authentication: key ID as user name, key secret as password.

const LUNO_BALANCE_URL = 'https://api.luno.com/api/1/balance';
const REQUEST_TIMEOUT_MS = 10000;

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
