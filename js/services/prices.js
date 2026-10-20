// Live price engine.
// Rules: reuse prices for 120 seconds, never replace a good price with zero,
// and fall back to the last saved prices when the request fails.

import {
  PRICE_API_URL,
  PRICE_CACHE_SECONDS,
  PRICE_CURRENCY,
  PRICE_MANUAL_REFRESH_COOLDOWN_MS,
  PRICE_REQUEST_TIMEOUT_MS,
  STORAGE_KEYS,
} from '../config.js';
import { getCoinIds } from '../logic/catalog.js';
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

async function requestPrices(coinIds) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PRICE_REQUEST_TIMEOUT_MS);

  try {
    const url = `${PRICE_API_URL}?ids=${coinIds.join(',')}&vs_currencies=${PRICE_CURRENCY}`;
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`The price service answered with status ${response.status}.`);

    const body = await response.json();
    const prices = {};
    for (const coinId of coinIds) {
      const value = body?.[coinId]?.[PRICE_CURRENCY];
      if (Number.isFinite(value) && value > 0) prices[coinId] = value;
    }
    return prices;
  } finally {
    clearTimeout(timer);
  }
}

// Always resolves. The status tells the screen what happened:
//   live   : new prices were fetched
//   cached : prices were reused from the last 120 seconds
//   failed : the request failed, so older saved prices are used
export async function loadMarketPrices({ force = false } = {}) {
  const now = Date.now();
  const cache = readCache();

  if (!force && isFresh(cache, now)) {
    return { coinPrices: cache.prices, status: 'cached', updatedAt: cache.savedAt, errorMessage: '' };
  }
  // Repeated taps on Refresh reuse the previous answer, so the price service is not flooded.
  if (force && lastResult && now - lastAttemptAt < PRICE_MANUAL_REFRESH_COOLDOWN_MS) {
    return lastResult;
  }

  lastAttemptAt = now;

  try {
    const livePrices = await requestPrices(getCoinIds());
    const merged = { ...cache.prices, ...livePrices };
    if (Object.keys(livePrices).length > 0) {
      localStore.setJson(STORAGE_KEYS.priceCache, { savedAt: now, prices: merged });
    }
    lastResult = { coinPrices: merged, status: 'live', updatedAt: now, errorMessage: '' };
  } catch (error) {
    const reason = error?.name === 'AbortError' ? 'The price service took too long to answer.' : error?.message;
    lastResult = {
      coinPrices: cache.prices,
      status: 'failed',
      updatedAt: cache.savedAt,
      errorMessage: reason || 'The price service is unreachable.',
    };
  }

  return lastResult;
}
