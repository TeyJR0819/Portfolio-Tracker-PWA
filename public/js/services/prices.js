// Live price engine.
// Two sources: CoinGecko for crypto, and our Cloudflare function for stocks and exchange rates.
// Rules: reuse prices for 120 seconds, never replace a good price with zero,
// and fall back to the last saved prices when a request fails.

import {
  PRICE_API_URL,
  PRICE_CACHE_SECONDS,
  PRICE_CURRENCY,
  PRICE_MANUAL_REFRESH_COOLDOWN_MS,
  PRICE_REQUEST_TIMEOUT_MS,
  RATE_KEYS,
  STOCK_API_PATH,
  STORAGE_KEYS,
  USDT_COIN_ID,
} from '../config.js';
import { getCoinIds, getStockSymbols } from '../logic/catalog.js';
import { convertQuotesToMyr } from '../logic/quotes.js';
import { localStore } from './storage.js';

let lastAttemptAt = 0;
let lastResult = null;

function readCache() {
  const cache = localStore.getJson(STORAGE_KEYS.priceCache);
  const isValid = cache && typeof cache.savedAt === 'number' && cache.prices && typeof cache.prices === 'object';
  return isValid ? cache : { savedAt: 0, prices: {} };
}

function isFresh(cache, now) {
  return (now - cache.savedAt) / 1000 < PRICE_CACHE_SECONDS;
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PRICE_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`The price service answered with status ${response.status}.`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function requestCoinPrices() {
  const coinIds = getCoinIds();
  const body = await fetchJson(`${PRICE_API_URL}?ids=${coinIds.join(',')}&vs_currencies=${PRICE_CURRENCY}`);
  const prices = {};

  for (const coinId of coinIds) {
    const value = body?.[coinId]?.[PRICE_CURRENCY];
    if (Number.isFinite(value) && value > 0) prices[coinId] = value;
  }
  if (Object.keys(prices).length === 0) throw new Error('CoinGecko returned no prices.');

  if (prices[USDT_COIN_ID]) prices[RATE_KEYS.USDT] = prices[USDT_COIN_ID];
  return prices;
}

async function requestStockPrices(usdtRate) {
  const symbols = getStockSymbols().join(',');
  const body = await fetchJson(`${STOCK_API_PATH}?symbols=${encodeURIComponent(symbols)}`);
  const prices = convertQuotesToMyr(body, usdtRate);
  if (Object.keys(prices).length === 0) throw new Error('The stock service returned no prices.');
  return prices;
}

function describeFailure(label, error) {
  const reason = error?.name === 'AbortError' ? 'it took too long to answer' : error?.message || 'it is unreachable';
  return `${label}: ${reason}`;
}

// Always resolves. The status tells the screen what happened:
//   live    : all sources answered
//   partial : one source failed, so its older saved prices are used
//   cached  : prices were reused from the last 120 seconds
//   failed  : every source failed, so older saved prices are used
export async function loadMarketPrices({ force = false } = {}) {
  const now = Date.now();
  const cache = readCache();

  if (!force && isFresh(cache, now)) {
    return { marketPrices: cache.prices, status: 'cached', updatedAt: cache.savedAt, errorMessage: '' };
  }
  // Repeated taps on Refresh reuse the previous answer, so the price services are not flooded.
  if (force && lastResult && now - lastAttemptAt < PRICE_MANUAL_REFRESH_COOLDOWN_MS) {
    return lastResult;
  }

  lastAttemptAt = now;

  // The USDT rate stands in for USD when the stock service has no USD rate, so crypto goes first.
  const coinOutcome = await requestCoinPrices().then(
    (prices) => ({ prices }),
    (error) => ({ failure: describeFailure('Crypto prices', error) }),
  );
  const usdtRate = coinOutcome.prices?.[RATE_KEYS.USDT] ?? cache.prices[RATE_KEYS.USDT] ?? null;
  const stockOutcome = await requestStockPrices(usdtRate).then(
    (prices) => ({ prices }),
    (error) => ({ failure: describeFailure('Stock prices', error) }),
  );

  const fresh = { ...coinOutcome.prices, ...stockOutcome.prices };
  const failures = [coinOutcome.failure, stockOutcome.failure].filter(Boolean);
  const merged = { ...cache.prices, ...fresh };

  if (Object.keys(fresh).length > 0) {
    localStore.setJson(STORAGE_KEYS.priceCache, { savedAt: now, prices: merged });
  }

  const hasFreshPrices = Object.keys(fresh).length > 0;
  lastResult = {
    marketPrices: merged,
    status: !hasFreshPrices ? 'failed' : failures.length > 0 ? 'partial' : 'live',
    updatedAt: hasFreshPrices ? now : cache.savedAt,
    errorMessage: failures.join('. '),
  };
  return lastResult;
}
