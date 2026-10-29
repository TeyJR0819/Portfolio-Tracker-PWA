// The single place where the app keeps its data.
// Call updateState to change data. Every subscriber is told once afterwards.

import { buildHoldings, convertHoldings, findRate, summarise } from './logic/calculations.js';

const state = {
  positions: [],
  marketPrices: {},
  priceInfo: null, // { status, updatedAt, errorMessage }
  dataInfo: null, // { isOffline, savedAt, errorMessage }
  transactions: [],
  transactionsError: '',
  displayCurrency: 'MYR', // 'MYR' or 'USD'. Only changes how amounts are shown.
  activeTab: 'summary',
};

const listeners = new Set();
let cachedBase = null;
let cachedDisplay = null;

function clearCache() {
  cachedBase = null;
  cachedDisplay = null;
}

export function getState() {
  return state;
}

export function updateState(changes) {
  Object.assign(state, changes);
  clearCache();
  listeners.forEach((listener) => listener(state));
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function resetState() {
  Object.assign(state, {
    positions: [],
    marketPrices: {},
    priceInfo: null,
    dataInfo: null,
    transactions: [],
    transactionsError: '',
  });
  clearCache();
}

// RM per 1 USD, or null when the rate is not known yet.
export function getUsdRate() {
  return findRate(state.marketPrices, 'USD');
}

// 'USD' only when the person chose it and a rate exists. Otherwise 'MYR'.
export function getDisplayCurrency() {
  return state.displayCurrency === 'USD' && getUsdRate() ? 'USD' : 'MYR';
}

function buildPortfolio(holdings) {
  return { holdings, summary: summarise(holdings) };
}

// Holdings and totals in RM, as stored. Used for saving and for the CSV file.
export function getBasePortfolio() {
  if (!cachedBase) cachedBase = buildPortfolio(buildHoldings(state.positions, state.marketPrices));
  return cachedBase;
}

// Holdings and totals in the display currency. Calculated once per change, then reused.
export function getPortfolio() {
  const base = getBasePortfolio();
  if (getDisplayCurrency() === 'MYR') return base;

  if (!cachedDisplay) cachedDisplay = buildPortfolio(convertHoldings(base.holdings, getUsdRate()));
  return cachedDisplay;
}
