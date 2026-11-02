// One-time diagnostic. Pionex does not document the reply of its Earn balance endpoints, so this prints only the
// SHAPE of each reply: field names and types, plus short text values such as coin names. Numbers are never printed,
// so the log (which may be public in a public repository) shows no amounts. Secrets: PIONEX_API_KEY, PIONEX_API_SECRET.
import { sign } from '../src/brokers/pionex.js';

const ORIGIN = 'https://api.pionex.com';
const PATHS = ['/api/v1/earn/arbitrage/fetchUserBalances', '/api/v1/earn/dual/balances'];

function shape(value, depth = 0) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return depth > 5 ? '[…]' : `[${value.length} items] ${value.length ? JSON.stringify(shape(value[0], depth + 1)) : ''}`;
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, depth > 5 ? '…' : shape(inner, depth + 1)]));
  }
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return String(value);
  const text = String(value);
  return /^-?[0-9.]+(e-?[0-9]+)?$/i.test(text) ? 'numeric string' : text.slice(0, 40);
}

for (const path of PATHS) try {
  const query = `timestamp=${Date.now()}`;
  const signature = await sign(process.env.PIONEX_API_SECRET, `GET${path}?${query}`);
  const response = await fetch(`${ORIGIN}${path}?${query}`, { headers: { 'PIONEX-KEY': process.env.PIONEX_API_KEY, 'PIONEX-SIGNATURE': signature } });
  const body = await response.json().catch(() => null);
  console.log(`${path} -> HTTP ${response.status}`);
  console.log(JSON.stringify(shape(body), null, 2));
} catch (error) {
  console.log(`${path} -> failed: ${error.message}`);
}
