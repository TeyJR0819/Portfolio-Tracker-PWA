// The "Trades from your brokers" card on the Summary tab.
// The Worker saves the trades. This card lists the ones that are not in the ledger yet and, when asked,
// records them with the same rules as a typed Buy or Sell.

import { findNewTrades, importTrades } from '../logic/trade-import.js';
import { cachePositions, saveEntry } from '../services/database.js';
import { getState, updateState } from '../state.js';
import { byId } from './dom.js';
import { showToast } from './toast.js';

let isImporting = false;

function describeNewTrades(trades) {
  if (trades.length === 0) return 'Every trade the brokers reported is already in your ledger.';
  const brokers = [...new Set(trades.map((trade) => trade.broker))].join(' and ');
  const noun = trades.length === 1 ? 'trade' : 'trades';
  return `${trades.length} ${noun} from ${brokers} ${trades.length === 1 ? 'is' : 'are'} not in your ledger yet.`;
}

function getNewTrades() {
  const { brokerSync } = getState();
  return findNewTrades({ trades: brokerSync.trades, importedIds: brokerSync.importedIds, sinceDate: byId('trade-import-since').value });
}

export function renderTradeImport({ brokerSync }) {
  byId('trade-import').hidden = brokerSync.trades.length === 0;
  if (brokerSync.trades.length === 0) return;

  const trades = getNewTrades();
  byId('trade-import-summary').textContent = describeNewTrades(trades);
  byId('trade-import-submit').disabled = isImporting || trades.length === 0;
  byId('trade-import-submit').textContent = isImporting ? 'Importing' : 'Import trades';
}

async function handleSubmit(event) {
  event.preventDefault();
  const state = getState();
  if (isImporting) return;
  if (state.dataInfo?.isOffline) {
    showToast('You are viewing a saved copy. Reconnect before importing.', 'warning');
    return;
  }

  const trades = getNewTrades();
  if (trades.length === 0) return;

  isImporting = true;
  updateState({});
  const result = await importTrades({
    trades,
    positions: state.positions,
    marketPrices: state.marketPrices,
    useCash: byId('trade-import-cash').checked,
    save: saveEntry,
  });
  isImporting = false;

  const latest = getState();
  cachePositions(result.positions);
  updateState({
    positions: result.positions,
    transactions: [...result.transactions.reverse(), ...latest.transactions],
    brokerSync: { ...latest.brokerSync, importedIds: [...latest.brokerSync.importedIds, ...result.importedIds] },
  });

  if (result.message) showToast(result.message, 'warning');
  else showToast(`${result.importedIds.length} trades imported`, 'positive');
}

export function initTradeImport() {
  byId('trade-import-form').addEventListener('submit', handleSubmit);
  byId('trade-import-since').addEventListener('change', () => updateState({}));
}
