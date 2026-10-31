// Turns trades read from the brokers into ledger entries.
// The Worker stores each trade already in ledger terms (see src/brokers/trades.js), so this file only
// decides which trades are new and plans them one by one with the same rules as a typed entry.
// The Worker (src/ledger-sync.js) saves the result.
// Pure logic, tested in tests/trade-import.test.js.

import { DISPLAY_TIME_ZONE, MONEY_DECIMALS, QUANTITY_DECIMALS } from '../public/js/config.js';
import { QUANTITY_EPSILON, roundTo } from '../public/js/logic/calculations.js';
import { findAsset, findPosition } from '../public/js/logic/catalog.js';
import { addUnits, planEntry } from '../public/js/logic/ledger.js';

// 'YYYY-MM-DD' in the display time zone.
export function toTradeDate(timestamp) {
  return new Date(timestamp).toLocaleDateString('en-CA', { timeZone: DISPLAY_TIME_ZONE });
}

function isTrackedTrade(trade) {
  const entry = findAsset(trade.asset);
  return Boolean(entry && entry.category === 'Crypto' && entry.brokers.includes(trade.broker));
}

// Trades and transfers that are not in the ledger yet, oldest first. sinceDate ('YYYY-MM-DD') is optional.
export function findNewTrades({ trades, importedIds, sinceDate = '' }) {
  const imported = new Set(importedIds);
  return trades
    .filter((trade) => !imported.has(trade.externalId) && isTrackedTrade(trade))
    .filter((trade) => !sinceDate || toTradeDate(trade.tradedAt) >= sinceDate)
    .sort((a, b) => a.tradedAt - b.tradedAt || a.externalId.localeCompare(b.externalId));
}

// The same input the Add entry form would send for a buy or sell trade.
function tradeToEntry(trade, { useCash, marketPrices = {}, positions = [] }) {
  let total = trade.cashAmount;
  if (!total || total <= 0) {
    const coinId = findAsset(trade.asset)?.coinId;
    const held = findPosition(positions, trade.broker, trade.asset);
    const avgCost = held && held.qty > 0 ? held.costMyr / held.qty : 0;
    const marketPrice = coinId ? (marketPrices[coinId] ?? 0) : 0;
    const unitPrice = marketPrice > 0 ? marketPrice : avgCost;
    if (unitPrice <= 0) {
      throw new Error(`The ${trade.asset} to RM price is not available.`);
    }
    total = roundTo(trade.qty * unitPrice, MONEY_DECIMALS);
  }
  return {
    kind: trade.side,
    broker: trade.broker,
    asset: trade.asset,
    qty: trade.qty,
    entryMode: 'total',
    total,
    fee: trade.feeQuote,
    useCash,
    tradeDate: toTradeDate(trade.tradedAt),
    note: `Imported from ${trade.broker}`,
    externalId: trade.externalId,
  };
}

// Export for tests.
export { tradeToEntry };

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

const OPENING_NOTE = 'Opening balance: no purchase found in the history';

// A sale of more coins than the ledger holds means the coins came from somewhere the history does not show
// (a deposit, staking, an older trade). The missing coins are added first, at the price they were sold for,
// so the sale shows no profit or loss on them and the later trades are not blocked.
function planOpeningBalance(trade, positions, marketPrices) {
  if (trade.side !== 'sell') return null;
  const held = findPosition(positions, trade.broker, trade.asset)?.qty ?? 0;
  const shortfall = Number((trade.qty - held).toFixed(QUANTITY_DECIMALS));
  if (shortfall <= QUANTITY_EPSILON) return null;

  const entry = {
    kind: 'buy', broker: trade.broker, asset: trade.asset, qty: shortfall, entryMode: 'total',
    total: shortfall * (trade.cashAmount / trade.qty), fee: 0, useCash: false,
    tradeDate: toTradeDate(trade.tradedAt), note: OPENING_NOTE, externalId: '',
  };
  return { plan: planEntry(entry, { positions, marketPrices }), shortfall };
}

// A staking reward is new coins that cost nothing: the quantity grows, the cost stays, so the average price falls.
// The staked principal is never recorded here, because it stays in the same Luno balance at the wallet price.
function planStakingReward(trade, positions) {
  const position = findPosition(positions, trade.broker, trade.asset) ?? {
    id: null, category: 'Crypto', broker: trade.broker, asset: trade.asset, qty: 0, costMyr: 0, realisedPl: 0,
  };
  const changes = [{ before: position, after: addUnits(position, trade.qty, 0) }];
  const record = {
    tradeDate: toTradeDate(trade.tradedAt), kind: 'buy', broker: trade.broker, asset: trade.asset,
    qty: trade.qty, price: 0, currency: 'MYR', fee: 0, rate: 1, totalMyr: 0,
    fromAccount: '', toAccount: `${trade.broker} ${trade.asset}`, amountFrom: 0, amountTo: trade.qty,
    realisedPl: 0, note: `Staking reward (${trade.broker}), cost RM 0.00`, externalId: trade.externalId,
  };
  return { changes, record };
}

// ---------------------------------------------------------------------------
// On-chain transfer handling:
// - Transfer out from Luno (side === 'send' or 'transfer_to_pionex'):
//   Coins are deducted from Luno and added into Pionex, carrying their
//   proportional cost basis with 0 realised P/L.
// - Crypto receive at Luno (side === 'receive'):
//   Coins are deposited into Luno at market price (or cost if known).
// ---------------------------------------------------------------------------
function planCryptoTransfer(trade, positions, marketPrices) {
  const isSend = trade.side === 'send' || trade.side === 'transfer_to_pionex';

  if (isSend) {
    // Coins leave Luno and go to Pionex
    const lunoPos = findPosition(positions, 'Luno', trade.asset) ?? {
      id: null, category: 'Crypto', broker: 'Luno', asset: trade.asset, qty: 0, costMyr: 0, realisedPl: 0,
    };
    const pionexPos = findPosition(positions, 'Pionex', trade.asset) ?? {
      id: null, category: 'Crypto', broker: 'Pionex', asset: trade.asset, qty: 0, costMyr: 0, realisedPl: 0,
    };

    let currentLuno = lunoPos;
    if (currentLuno.qty < trade.qty - QUANTITY_EPSILON) {
      const shortfall = roundTo(trade.qty - currentLuno.qty, QUANTITY_DECIMALS);
      const coinId = findAsset(trade.asset)?.coinId;
      const avgCost = currentLuno.qty > 0 ? currentLuno.costMyr / currentLuno.qty : 0;
      const price = avgCost > 0 ? avgCost : (coinId ? (marketPrices[coinId] ?? 0) : 0);
      const addedCost = roundTo(shortfall * price, MONEY_DECIMALS);
      currentLuno = {
        ...currentLuno,
        qty: roundTo(currentLuno.qty + shortfall, QUANTITY_DECIMALS),
        costMyr: roundTo(currentLuno.costMyr + addedCost, MONEY_DECIMALS),
      };
    }

    const avgCost = currentLuno.qty > 0 ? currentLuno.costMyr / currentLuno.qty : 0;
    const transferCost = roundTo(Math.min(trade.qty, currentLuno.qty) * avgCost, MONEY_DECIMALS);
    const remainingQty = roundTo(Math.max(0, currentLuno.qty - trade.qty), QUANTITY_DECIMALS);
    const remainingCost = roundTo(Math.max(0, currentLuno.costMyr - transferCost), MONEY_DECIMALS);

    const lunoAfter = {
      ...currentLuno,
      qty: remainingQty <= QUANTITY_EPSILON ? 0 : remainingQty,
      costMyr: remainingQty <= QUANTITY_EPSILON ? 0 : remainingCost,
    };

    const pionexAfter = {
      ...pionexPos,
      qty: roundTo(pionexPos.qty + trade.qty, QUANTITY_DECIMALS),
      costMyr: roundTo(pionexPos.costMyr + transferCost, MONEY_DECIMALS),
    };

    const changes = [
      { before: lunoPos, after: lunoAfter },
      { before: pionexPos, after: pionexAfter },
    ];

    const record = {
      tradeDate: toTradeDate(trade.tradedAt),
      kind: 'transfer',
      broker: 'Luno',
      asset: trade.asset,
      qty: trade.qty,
      price: avgCost,
      currency: 'MYR',
      fee: 0,
      rate: 1,
      totalMyr: transferCost,
      fromAccount: `Luno ${trade.asset}`,
      toAccount: `Pionex ${trade.asset}`,
      amountFrom: trade.qty,
      amountTo: trade.qty,
      realisedPl: 0,
      note: `Transferred ${trade.qty} ${trade.asset} from Luno to Pionex`,
      externalId: trade.externalId,
    };

    return { changes, record };
  }

  // Receive: coins arrive at Luno from outside
  const position = findPosition(positions, trade.broker, trade.asset) ?? {
    id: null, category: 'Crypto', broker: trade.broker, asset: trade.asset, qty: 0, costMyr: 0, realisedPl: 0,
  };
  const coinId = findAsset(trade.asset)?.coinId;
  const price = trade.cashAmount > 0 ? trade.cashAmount / trade.qty : (coinId ? (marketPrices[coinId] ?? 0) : 0);
  const costMyr = roundTo(trade.qty * price, MONEY_DECIMALS);
  const after = addUnits(position, trade.qty, costMyr);

  const changes = [{ before: position, after }];
  const record = {
    tradeDate: toTradeDate(trade.tradedAt),
    kind: 'deposit',
    broker: trade.broker,
    asset: trade.asset,
    qty: trade.qty,
    price,
    currency: 'MYR',
    fee: 0,
    rate: 1,
    totalMyr: costMyr,
    fromAccount: 'Outside',
    toAccount: `${trade.broker} ${trade.asset}`,
    amountFrom: trade.qty,
    amountTo: trade.qty,
    realisedPl: 0,
    note: `Received ${trade.qty} ${trade.asset} at ${trade.broker}`,
    externalId: trade.externalId,
  };

  return { changes, record };
}

// Works out what the ledger looks like after the trades, without saving anything.
// A trade that cannot be recorded (for example a missing exchange rate) holds back only the later trades of the
// same coin at the same broker, never the other coins, so one problem cannot block the whole history.
// Returns { positions, records, importedIds, openingCount, blockedKeys, message }. message is empty when all went well.
export function planTradeImport({ trades, positions, marketPrices, useCash = false }) {
  let current = positions;
  const records = [];
  const importedIds = [];
  const blocked = new Map(); // "broker|asset" -> the first problem
  let openingCount = 0;

  for (const trade of trades) {
    const key = `${trade.broker}|${trade.asset}`;
    if (blocked.has(key)) continue;

    try {
      if (trade.side === 'staking_reward') {
        const reward = planStakingReward(trade, current);
        current = applyChanges(current, reward.changes);
        records.push(reward.record);
        importedIds.push(trade.externalId);
      } else if (trade.side === 'receive' || trade.side === 'send' || trade.side === 'transfer_to_pionex') {
        const transfer = planCryptoTransfer(trade, current, marketPrices);
        current = applyChanges(current, transfer.changes);
        records.push(transfer.record);
        importedIds.push(trade.externalId);
      } else {
        // Regular buy or sell trade
        const opening = planOpeningBalance(trade, current, marketPrices);
        if (opening) {
          current = applyChanges(current, opening.plan.changes);
          records.push(opening.plan.record);
          openingCount += 1;
        }
        const plan = planEntry(tradeToEntry(trade, { useCash, marketPrices, positions: current }), { positions: current, marketPrices });
        current = applyChanges(current, plan.changes);
        records.push(plan.record);
        importedIds.push(trade.externalId);
      }
    } catch (error) {
      blocked.set(key, `Held back the ${describeTrade(trade)}: ${error.message}`);
    }
  }

  const problems = [...blocked.values()].slice(0, 2).join(' ');
  return { positions: current, records, importedIds, openingCount, blockedKeys: new Set(blocked.keys()), message: problems };
}
