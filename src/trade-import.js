// Turns trades read from the brokers into ledger entries.
// The Worker stores each trade already in ledger terms (see src/brokers/trades.js), so this file only
// decides which trades are new and plans them one by one with the same rules as a typed entry.
// The Worker (src/ledger-sync.js) saves the result.
// Pure logic, tested in tests/trade-import.test.js.

import { DISPLAY_TIME_ZONE } from '../public/js/config.js';
import { findAsset } from '../public/js/logic/catalog.js';
import { planEntry } from '../public/js/logic/ledger.js';

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

const keyOf = (position) => `${position.broker}|${position.asset}`;

// Puts the changed balances of one planned entry into the list. New balances have id null until they are saved.
export function applyChanges(positions, changes) {
  const next = [...positions];
  for (const { after } of changes) {
    const index = next.findIndex((position) => keyOf(position) === keyOf(after));
    if (index >= 0) next[index] = after;
    else next.push(after);
  }
  return next;
}

function describeTrade(trade) {
  return `${trade.broker} ${trade.side} of ${trade.qty} ${trade.asset} on ${toTradeDate(trade.tradedAt)}`;
}

// Works out what the ledger looks like after the trades, without saving anything.
// Stops at the first trade that cannot be recorded (for example a sale of coins the ledger does not hold),
// so a later trade is never recorded on top of a missing earlier one.
// Returns { positions, records, importedIds, message }. message is empty when every trade was planned.
export function planTradeImport({ trades, positions, marketPrices, useCash = false }) {
  let current = positions;
  const records = [];
  const importedIds = [];

  for (const trade of trades) {
    try {
      const plan = planEntry(tradeToEntry(trade, { useCash }), { positions: current, marketPrices });
      current = applyChanges(current, plan.changes);
      records.push(plan.record);
      importedIds.push(trade.externalId);
    } catch (error) {
      const earlier = importedIds.length;
      const note = earlier > 0 ? ` ${earlier} ${earlier === 1 ? 'trade was' : 'trades were'} recorded before it.` : '';
      return { positions: current, records, importedIds, message: `Stopped at the ${describeTrade(trade)}. ${error.message}${note}` };
    }
  }
  return { positions: current, records, importedIds, message: '' };
}
