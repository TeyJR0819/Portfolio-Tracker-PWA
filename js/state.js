// The single place where the app keeps its data.
// Call updateState to change data. Every subscriber is told once afterwards.

import { buildHoldings, summarise } from './logic/calculations.js';

const state = {
  positions: [],
  coinPrices: {},
  priceInfo: null, // { status, updatedAt, errorMessage }
  dataInfo: null, // { isOffline, savedAt, errorMessage }
  activeTab: 'summary',
};

const listeners = new Set();
let cachedPortfolio = null;

export function getState() {
  return state;
}

export function updateState(changes) {
  Object.assign(state, changes);
  cachedPortfolio = null;
  listeners.forEach((listener) => listener(state));
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function resetState() {
  Object.assign(state, { positions: [], coinPrices: {}, priceInfo: null, dataInfo: null });
  cachedPortfolio = null;
}

// Holdings and totals are calculated once per change, then reused.
export function getPortfolio() {
  if (!cachedPortfolio) {
    const holdings = buildHoldings(state.positions, state.coinPrices);
    cachedPortfolio = { holdings, summary: summarise(holdings) };
  }
  return cachedPortfolio;
}
