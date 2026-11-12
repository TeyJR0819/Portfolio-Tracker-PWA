// Asks our Cloudflare function for asset search results and candles.

import { CANDLES_API_PATH, CHART_SEARCH_API_PATH, PRICE_REQUEST_TIMEOUT_MS } from '../config.js';

async function requestJson(url, signal) {
  const timeout = AbortSignal.timeout(PRICE_REQUEST_TIMEOUT_MS + 4000);
  const response = await fetch(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error || `The chart service answered with status ${response.status}.`);
  return body;
}

// Returns [{ symbol, coin, ticker, name, type, exchange }].
export async function searchAssets(query, signal) {
  const body = await requestJson(`${CHART_SEARCH_API_PATH}?q=${encodeURIComponent(query)}`, signal);
  return Array.isArray(body.results) ? body.results : [];
}

// Returns { candles, currency, nativeCurrency, source, name, note }.
export async function loadCandles(item, interval, currency, signal) {
  const params = new URLSearchParams({ interval, currency });
  if (item.symbol) params.set('symbol', item.symbol);
  if (item.coin) params.set('coin', item.coin);
  const body = await requestJson(`${CANDLES_API_PATH}?${params}`, signal);
  if (!Array.isArray(body.candles) || body.candles.length === 0) throw new Error('The chart service returned no candles.');
  return body;
}
