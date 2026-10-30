// Turns trades read from the brokers into ledger entries.
// The Worker stores each trade already in ledger terms (see src/brokers/trades.js), so this file only
// decides which trades are new and records them one by one with the same rules as a typed entry.
// No browser features are used here, so it is tested in tests/trade-import.test.js.

import { DISPLAY_TIME_ZONE } from '../config.js';
import { findAsset } from './catalog.js';
import { planEntry } from './ledger.js';

// 'YYYY-MM-DD' in the display time zone.
export function toTradeDate(timestamp) {
  return new Date(timestamp).toLocaleDateString('en-CA', { timeZone: DISPLAY_TIME_ZONE });
}

function isTrackedTrade(trade) {
  const entry = findAsset(trade.asset);
  return Boolean(entry && entry.category === 'Crypto' && entry.brokers.includes(trade.broker));
}

// Trades that are not in the ledger yet, oldest first. sinceDate ('YYYY-MM-DD') is optional.
export function findNewTrades({ trades, importedIds, sinceDate = '' }) {
  const imported = new Set(importedIds);
  return trades
    .filter((trade) => !imported.has(trade.externalId) && isTrackedTrade(trade))
    .filter((trade) => !sinceDate || toTradeDate(trade.tradedAt) >= sinceDate)
    .sort((a, b) => a.tradedAt - b.tradedAt || a.externalId.localeCompare(b.externalId));
}

// The same input the Add entry form would send for this trade.
export function tradeToEntry(trade, { useCash }) {
  return {
    kind: trade.side,
    broker: trade.broker,
    asset: trade.asset,
    qty: trade.qty,
    entryMode: 'total',
    total: trade.cashAmount,
    fee: trade.feeQuote,
    useCash,
    tradeDate: toTradeDate(trade.tradedAt),
    note: `Imported from ${trade.broker}`,
    externalId: trade.externalId,
  };
}

function mergePositions(positions, saved) {
  const byId = new Map(positions.map((position) => [position.id, position]));
  saved.forEach((position) => byId.set(position.id, position));
  return [...byId.values()];
}

function describeTrade(trade) {
  return `${trade.broker} ${trade.side} of ${trade.qty} ${trade.asset} on ${toTradeDate(trade.tradedAt)}`;
}

// Records the trades in order. Stops at the first one that cannot be recorded, so a later trade is
// never recorded on top of a missing earlier one.
//   save: async ({ changes, record }) => { positions, transaction, logError }   (saveEntry in the app)
// Returns { importedIds, positions, transactions, message }. message is empty when every trade was recorded.
export async function importTrades({ trades, positions, marketPrices, useCash, save }) {
  let current = positions;
  const importedIds = [];
  const transactions = [];
  const stop = (trade, reason) => ({
    importedIds,
    positions: current,
    transactions,
    message: `Stopped at the ${describeTrade(trade)}. ${reason}${importedIds.length > 0 ? ` ${importedIds.length} ${importedIds.length === 1 ? 'trade was' : 'trades were'} recorded before it.` : ''}`,
  });

  for (const trade of trades) {
    let plan;
    try {
      plan = planEntry(tradeToEntry(trade, { useCash }), { positions: current, marketPrices });
    } catch (error) {
      return stop(trade, error.message);
    }

    let saved;
    try {
      saved = await save(plan);
    } catch (error) {
      return stop(trade, error.message);
    }

    current = mergePositions(current, saved.positions);
    if (saved.transaction) transactions.push(saved.transaction);
    importedIds.push(trade.externalId);
    if (saved.logError) return stop(trade, `The balances were saved, but the history line was not (${saved.logError}). Press Refresh and check before importing again.`);
  }
  return { importedIds, positions: current, transactions, message: '' };
}
