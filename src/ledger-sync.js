// Keeps the ledger (the portfolio and transactions tables) in step with the brokers, without any typing.
//
//   1. Any previously imported Luno inflow/transfer rows whose cost or side was updated by the latest
//      Luno sync (for example an early Instant Buy that now has its true MYR cost from the MYR wallet,
//      or a staking principal move that was paired and removed) are reconciled cleanly.
//   2. Every trade, Instant Buy, staking reward or transfer that the broker sync saved in broker_trades,
//      and that is not in the ledger yet, is recorded with the same rules as a typed entry.
//   3. Luno crypto balances are verified against Luno's reported balance (normal + staking combined).
//      Any residual staking reward gap is added at RM 0.00 cost so Ledger always matches Broker says.
//   4. The cash of Luno and Pionex is set to the balance the broker reports.

import { PRICE_API_URL, PRICE_CURRENCY, RATE_KEYS, USDT_COIN_ID } from '../public/js/config.js';
import { getCoinIds } from '../public/js/logic/catalog.js';
import { planEntry } from '../public/js/logic/ledger.js';
import { toDatabaseRow, toPosition, toTransactionRow } from '../public/js/logic/rows.js';
import { createDatabase } from './supabase.js';
import { applyChanges, findNewTrades, planBalanceAlignment, planTradeImport, toTradeDate } from './trade-import.js';
import { TRADED_ASSETS } from './brokers/trades.js';

export const LEDGER_STATUS_NAME = 'Ledger';

// Cash accounts that are set to the broker's own balance.
const CASH_ACCOUNTS = Object.freeze([
  { broker: 'Luno', asset: 'Luno Cash' },
  { broker: 'Pionex', asset: 'Pionex Cash' },
]);

const TRANSACTION_BATCH_SIZE = 200;
const RATE_TIMEOUT_MS = 8000;
const RECONCILE_TOLERANCE = 1e-6;
const keyOf = (position) => `${position.broker}|${position.asset}`;

// Loads USDT rate AND all tracked crypto prices in MYR, so on-chain transfers can be valued.
async function loadMarketPrices(fetchImpl) {
  try {
    const ids = getCoinIds().join(',');
    const url = `${PRICE_API_URL}?ids=${ids}&vs_currencies=${PRICE_CURRENCY}`;
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(RATE_TIMEOUT_MS) });
    if (!response.ok) return {};
    const data = await response.json();
    const prices = {};
    for (const [coinId, rates] of Object.entries(data)) {
      const myrPrice = Number(rates?.[PRICE_CURRENCY]);
      if (Number.isFinite(myrPrice) && myrPrice > 0) {
        prices[coinId] = myrPrice;
      }
    }
    const usdtPrice = prices[USDT_COIN_ID];
    if (usdtPrice) prices[RATE_KEYS.USDT] = usdtPrice;
    return prices;
  } catch {
    return {};
  }
}

// Sets the cash accounts to the broker's balance. Returns { positions, records, notes }.
function planCashAlignment({ positions, balances, syncedBrokers, marketPrices, tradeDate }) {
  let current = positions;
  const records = [];
  const notes = [];

  for (const { broker, asset } of CASH_ACCOUNTS) {
    if (!syncedBrokers.has(broker)) continue;
    const reported = balances.find((row) => row.broker === broker && row.asset === asset)?.qty ?? 0;
    try {
      const plan = planEntry({ kind: 'adjust', account: asset, balance: reported, tradeDate, note: `Synced from ${broker}` }, { positions: current, marketPrices });
      current = applyChanges(current, plan.changes);
      records.push(plan.record);
    } catch (error) {
      if (error.message !== 'The balance already has this value.') notes.push(`${asset}: ${error.message}`);
    }
  }
  return { positions: current, records, notes };
}

// Sets every Luno coin to the quantity Luno reports (normal + staking wallet). Staking rewards are already read
// from the account history at RM 0.00, so a gap left here is something the history cannot explain. It is never
// booked as a free reward: the coins are added or removed at the average cost (or the market price when none are
// held), written as a visible "Balance corrected" line, and named in the Ledger status.
function planLunoCryptoAlignment({ positions, balances, syncedBrokers, blockedKeys, marketPrices, tradeDate }) {
  if (!syncedBrokers.has('Luno')) return { positions, records: [], notes: [] };
  const assets = TRADED_ASSETS.filter((asset) => !blockedKeys?.has(`Luno|${asset}`));
  return planBalanceAlignment({ positions, balances, broker: 'Luno', assets, marketPrices, tradeDate });
}

// Detects if any previously imported Luno transaction in `transactions` is stale or was misclassified
// (for example, an internal staking move `luno:transfer:*` / `luno:inflow:*` that is no longer in `broker_trades`,
// or an `Opening balance` row created because of a misclassified staking transfer, or an Instant Buy whose
// `cash_amount` was 0 / market-estimated before and now has its true MYR cost in `broker_trades`).
function needsCryptoLedgerRebuild({ tradeRows, importedRows, positionRows, balances, syncedBrokers }) {
  if (!syncedBrokers.has('Luno')) return false;
  const validTradeMap = new Map(tradeRows.map((row) => [row.external_id, row]));

  for (const tx of importedRows) {
    const extId = tx.external_id;
    if (!extId) continue;
    // If an old luno:inflow or luno:transfer was paired/cancelled as a staking move, it won't be in broker_trades
    if ((extId.startsWith('luno:inflow:') || extId.startsWith('luno:transfer:')) && !validTradeMap.has(extId)) {
      return true;
    }
    // If an Instant Buy in broker_trades now has a real MYR cash_amount that differs from what was recorded
    const brokerTrade = validTradeMap.get(extId);
    if (
      brokerTrade &&
      extId.startsWith('luno:inflow:') &&
      Number(brokerTrade.cash_amount) > 0 &&
      tx.total_myr !== undefined &&
      Math.abs(Number(tx.total_myr) - Number(brokerTrade.cash_amount)) > 0.05
    ) {
      return true;
    }
  }

  // Also check if any Luno crypto position has RM 0.00 / RM 0.01 cost while Luno trades have positive cost
  for (const pos of positionRows) {
    if (pos.category === 'Crypto' && pos.broker === 'Luno' && Number(pos.qty) > 0 && Number(pos.cost_myr) <= 0.05) {
      const hasPaidBuy = tradeRows.some(
        (t) => t.broker === 'Luno' && t.asset === pos.asset && t.side === 'buy' && Number(t.cash_amount) > 1,
      );
      if (hasPaidBuy) return true;
    }
  }

  // Check if Luno reported balance is smaller than Ledger balance (caused by old duplicate staking inflows)
  const trackedSet = new Set(TRADED_ASSETS);
  for (const bal of balances) {
    if (bal.broker !== 'Luno' || !trackedSet.has(bal.asset)) continue;
    const pos = positionRows.find((p) => p.broker === 'Luno' && p.asset === bal.asset);
    if (pos && Number(pos.qty) - Number(bal.qty) > RECONCILE_TOLERANCE) {
      return true;
    }
  }

  return false;
}

async function savePosition(database, position) {
  if (position.id !== null && position.id !== undefined) {
    const row = toDatabaseRow(position);
    const [saved] = await database.update('portfolio', `id=eq.${position.id}`, { qty: row.qty, cost_myr: row.cost_myr, realised_pl: row.realised_pl });
    return toPosition(saved);
  }
  try {
    const [saved] = await database.insert('portfolio', [toDatabaseRow(position)]);
    return toPosition(saved);
  } catch (error) {
    if (error.code !== '23502') throw error;
    const [latest] = await database.select('portfolio', 'select=id&order=id.desc&limit=1');
    const [saved] = await database.insert('portfolio', [{ id: (latest?.id ?? 0) + 1, ...toDatabaseRow(position) }]);
    return toPosition(saved);
  }
}

// Saves the planned change. Returns '' on success or a sentence on failure (and then nothing is changed).
async function commit(database, { originals, finalPositions, records }) {
  const insertedIds = [];
  try {
    for (let start = 0; start < records.length; start += TRANSACTION_BATCH_SIZE) {
      const rows = await database.insert('transactions', records.slice(start, start + TRANSACTION_BATCH_SIZE).map(toTransactionRow));
      insertedIds.push(...rows.map((row) => row.id));
    }
  } catch (error) {
    await undoTransactions(database, insertedIds);
    return error.status === 409
      ? 'Some of these trades are already in the ledger (another run saved them). It will check again in the next run.'
      : `The history could not be saved (${error.message}).`;
  }

  const changed = finalPositions.filter((position) => {
    const before = originals.get(keyOf(position));
    return !before || before.qty !== position.qty || before.costMyr !== position.costMyr || before.realisedPl !== position.realisedPl;
  });

  const saved = [];
  try {
    for (const position of changed) saved.push({ before: originals.get(keyOf(position)), after: await savePosition(database, position) });
    return '';
  } catch (error) {
    try {
      for (const { before, after } of saved.reverse()) {
        if (before) await savePosition(database, { ...before });
        else await database.remove('portfolio', `id=eq.${after.id}`);
      }
      await undoTransactions(database, insertedIds);
      return `A balance could not be saved (${error.message}). Nothing was changed.`;
    } catch {
      return `A balance could not be saved (${error.message}) and the undo failed. Check the portfolio table.`;
    }
  }
}

async function undoTransactions(database, ids) {
  if (ids.length > 0) await database.remove('transactions', `id=in.(${ids.join(',')})`);
}

function describeResult({ tradeCount, openingCount, cashChanges, notes, corrections = [], stopMessage }) {
  const parts = [];
  if (tradeCount > 0) parts.push(`${tradeCount} ${tradeCount === 1 ? 'trade' : 'trades'} recorded`);
  if (openingCount > 0) parts.push(`${openingCount} ${openingCount === 1 ? 'sale' : 'sales'} had no earlier purchase in the history, so those coins were counted at the sale price (no profit or loss)`);
  if (cashChanges > 0) parts.push(`${cashChanges} cash ${cashChanges === 1 ? 'balance' : 'balances'} synced`);
  if (corrections.length > 0) parts.push(`Luno balance corrected (not explained by the history): ${corrections.join(', ')}`);
  if (stopMessage) parts.push(stopMessage);
  parts.push(...notes);
  return parts.join('. ').slice(0, 300);
}

// Returns { broker: 'Ledger', ok, message } and saves the same line as the sync status.
export async function runLedgerSync(env, { fetchImpl = fetch, now = () => new Date() } = {}) {
  const missing = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY'].filter((name) => !env[name]);
  if (missing.length > 0) return { broker: LEDGER_STATUS_NAME, ok: false, message: `Missing secrets: ${missing.join(', ')}.` };

  const database = createDatabase(env, fetchImpl);
  const syncedAt = now().toISOString();
  let outcome;

  try {
    const statuses = await database.select('broker_sync_status', 'select=broker,ok');
    const syncedBrokers = new Set(statuses.filter((status) => status.ok).map((status) => status.broker));
    if (!CASH_ACCOUNTS.some(({ broker }) => syncedBrokers.has(broker))) {
      return { broker: LEDGER_STATUS_NAME, ok: true, message: 'Waiting for the first broker read.' };
    }

    let [tradeRows, importedRows, positionRows, balances, marketPrices] = await Promise.all([
      database.select('broker_trades', 'select=*&order=traded_at.asc,external_id.asc'),
      database.select('transactions', 'select=id,external_id,total_myr,note&external_id=not.is.null'),
      database.select('portfolio', 'select=*&order=id.asc'),
      database.select('broker_balances', 'select=broker,asset,qty'),
      loadMarketPrices(fetchImpl),
    ]);

    // Auto-heal if previous runs imported misclassified staking moves or unpriced instant buys
    if (needsCryptoLedgerRebuild({ tradeRows, importedRows, positionRows, balances, syncedBrokers })) {
      await database.remove('transactions', 'external_id=not.is.null');
      await database.remove('transactions', `note=eq.${encodeURIComponent('Opening balance: no purchase found in the history')}`);
      await database.remove('transactions', `note=eq.${encodeURIComponent('Staking reward (Luno), cost RM 0.00')}`);
      for (const pos of positionRows) {
        if (pos.category === 'Crypto') {
          await database.update('portfolio', `id=eq.${pos.id}`, { qty: 0, cost_myr: 0, realised_pl: 0 });
          pos.qty = 0;
          pos.cost_myr = 0;
          pos.realised_pl = 0;
        }
      }
      importedRows = [];
    }

    const positions = positionRows.map(toPosition);
    const originals = new Map(positions.map((position) => [keyOf(position), position]));
    const trades = tradeRows.map((row) => ({
      externalId: row.external_id, broker: row.broker, asset: row.asset, side: row.side,
      qty: Number(row.qty), cashAmount: Number(row.cash_amount), feeQuote: Number(row.fee_quote),
      quoteCurrency: row.quote_currency, tradedAt: Date.parse(row.traded_at),
    }));
    const newTrades = findNewTrades({ trades, importedIds: importedRows.map((row) => row.external_id) });

    const tradeDate = toTradeDate(now().getTime());
    const parsedBalances = balances.map((row) => ({ broker: row.broker, asset: row.asset, qty: Number(row.qty) }));

    // 1. Plan all trades, instant buys, staking rewards and transfers
    const tradePlan = planTradeImport({ trades: newTrades, positions, marketPrices, useCash: false });

    // 2. Align Luno crypto balances with Luno's reported balance (any unindexed staking rewards added at RM 0.00)
    const lunoAligned = planLunoCryptoAlignment({
      positions: tradePlan.positions,
      balances: parsedBalances,
      syncedBrokers,
      blockedKeys: tradePlan.blockedKeys,
      marketPrices,
      tradeDate,
    });

    // 3. Align cash accounts
    const cashPlan = planCashAlignment({
      positions: lunoAligned.positions,
      balances: parsedBalances,
      syncedBrokers,
      marketPrices,
      tradeDate,
    });

    const records = [...tradePlan.records, ...lunoAligned.records, ...cashPlan.records];
    const hasPositionChanges = cashPlan.positions.some((position) => {
      const before = originals.get(keyOf(position));
      return !before || before.qty !== position.qty || before.costMyr !== position.costMyr || before.realisedPl !== position.realisedPl;
    });

    let failure = '';
    if (records.length > 0 || hasPositionChanges) {
      failure = await commit(database, { originals, finalPositions: cashPlan.positions, records });
    }

    outcome = failure
      ? { broker: LEDGER_STATUS_NAME, ok: false, message: failure }
      : {
          broker: LEDGER_STATUS_NAME,
          ok: true,
          message: describeResult({
            tradeCount: tradePlan.importedIds.length,
            corrections: lunoAligned.notes,
            openingCount: tradePlan.openingCount,
            cashChanges: cashPlan.records.length,
            notes: cashPlan.notes,
            stopMessage: tradePlan.message,
          }),
        };
  } catch (error) {
    outcome = { broker: LEDGER_STATUS_NAME, ok: false, message: `Ledger sync failed (${String(error.message ?? 'unknown error').slice(0, 150)}).` };
  }

  try {
    await database.upsert('broker_sync_status', [{ broker: outcome.broker, ok: outcome.ok, message: outcome.message, synced_at: syncedAt }], 'broker');
  } catch {
    // The Worker log still shows the outcome.
  }
  return outcome;
}
