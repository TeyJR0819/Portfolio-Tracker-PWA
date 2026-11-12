// Saves the drawings and the watchlist.
// Supabase is the main copy, so they follow the person to another device. A copy is also kept on this device,
// so the chart still works offline or before the chart_state table exists.

import { STORAGE_KEYS } from '../config.js';
import { sanitiseDrawings } from '../logic/chart-drawings.js';
import { loadChartValue, saveChartValue } from './database.js';
import { localStore } from './storage.js';

const SAVE_DELAY_MS = 700;
const pendingTimers = new Map();
const pendingValues = new Map();

function localKey(key) {
  return `${STORAGE_KEYS.chartPrefix}${key}`;
}

export function drawingsKey(itemId, currency) {
  return `drawings:${itemId}:${currency}`;
}

export const WATCHLIST_KEY = 'watchlist';

// Returns { value, warning }. The warning is set when the shared copy could not be reached or written.
async function loadValue(key) {
  const local = localStore.getJson(localKey(key), null);
  try {
    const remote = await loadChartValue(key);
    if (remote !== null) {
      localStore.setJson(localKey(key), remote);
      return { value: remote, warning: '' };
    }
    // Nothing online yet: send the copy from this device up, so the other devices get it too.
    if (local !== null) saveChartValue(key, local).catch(() => {});
    return { value: local, warning: '' };
  } catch (error) {
    return { value: local, warning: describeSaveProblem(error) };
  }
}

function describeSaveProblem(error) {
  const message = String(error?.message ?? '');
  if (/chart_state|42P01|schema cache|not found/i.test(message)) {
    return 'Drawings are saved on this device only. Run sql/chart-state.sql in Supabase to save them online.';
  }
  return 'Drawings are saved on this device only because Supabase could not be reached.';
}

// Saves after a short pause, so dragging a line does not send a request for every pixel.
// onWarning receives a message when the online copy could not be written.
function saveValue(key, value, onWarning) {
  localStore.setJson(localKey(key), value);
  pendingValues.set(key, { value, onWarning });
  clearTimeout(pendingTimers.get(key));
  pendingTimers.set(key, setTimeout(() => flush(key), SAVE_DELAY_MS));
}

async function flush(key) {
  const pending = pendingValues.get(key);
  pendingValues.delete(key);
  pendingTimers.delete(key);
  if (!pending) return;
  try {
    await saveChartValue(key, pending.value);
  } catch (error) {
    pending.onWarning?.(describeSaveProblem(error));
  }
}

// Sends every waiting save at once, for example when the person leaves the tab.
export function flushChartSaves() {
  [...pendingTimers.keys()].forEach((key) => {
    clearTimeout(pendingTimers.get(key));
    flush(key);
  });
}

export async function loadDrawings(itemId, currency) {
  const { value, warning } = await loadValue(drawingsKey(itemId, currency));
  return { drawings: sanitiseDrawings(value), warning };
}

export function saveDrawings(itemId, currency, drawings, onWarning) {
  saveValue(drawingsKey(itemId, currency), drawings, onWarning);
}

function sanitiseWatchlist(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item.id === 'string' && (typeof item.symbol === 'string' || typeof item.coin === 'string'))
    .slice(0, 50)
    .map((item) => ({
      id: item.id,
      symbol: item.symbol || '',
      coin: item.coin || '',
      ticker: String(item.ticker || item.symbol || item.coin).slice(0, 20),
      name: String(item.name || item.id).slice(0, 80),
      type: String(item.type || ''),
    }));
}

export async function loadWatchlist() {
  const { value, warning } = await loadValue(WATCHLIST_KEY);
  return { watchlist: sanitiseWatchlist(value), warning };
}

export function saveWatchlist(watchlist, onWarning) {
  saveValue(WATCHLIST_KEY, watchlist, onWarning);
}

// The last chosen asset, timeframe, currency and indicators. Kept on this device only.
export function loadSettings() {
  return localStore.getJson(STORAGE_KEYS.chartSettings, {}) ?? {};
}

export function saveSettings(settings) {
  localStore.setJson(STORAGE_KEYS.chartSettings, settings);
}
