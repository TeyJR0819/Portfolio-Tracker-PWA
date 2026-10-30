// Keeps the ledger (the portfolio and transactions tables) in step with the brokers, without any typing.
//
//   1. Every trade that the broker sync saved in broker_trades, and that is not in the ledger yet,
//      is recorded as a Buy or Sell with the same rules as a typed entry (fees included in the cost).
//   2. The cash of Luno and Pionex is set to the balance the broker reports.
//
// Nothing is saved until the whole change has been worked out. Then the history lines are saved first
// (a unique trade id stops any trade being recorded twice), then each changed balance once.
// If a save fails, everything done in this run is undone.
//
// Pionex bots are left out by Pionex itself: its fills and balances cover non-strategy trading only.

import { PRICE_API_URL, PRICE_CURRENCY, RATE_KEYS, USDT_COIN_ID } from '../public/js/config.js';
import { planEntry } from '../public/js/logic/ledger.js';
import { toDatabaseRow, toPosition, toTransactionRow } from '../public/js/logic/rows.js';
import { createDatabase } from './supabase.js';
import { applyChanges, findNewTrades, planTradeImport, toTradeDate } from './trade-import.js';

export const LEDGER_STATUS_NAME = 'Ledger';

// Cash accounts that are set to the broker's own balance.
const CASH_ACCOUNTS = Object.freeze([
  { broker: 'Luno', asset: 'Luno Cash' },
  { broker: 'Pionex', asset: 'Pionex Cash' },
]);

const TRANSACTION_BATCH_SIZE = 200;
const RATE_TIMEOUT_MS = 8000;
const keyOf = (position) => `${position.broker}|${position.asset}`;

async function loadUsdtRate(fetchImpl) {
  try {
    const url = `${PRICE_API_URL}?ids=${USDT_COIN_ID}&vs_currencies=${PRICE_CURRENCY}`;
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(RATE_TIMEOUT_MS) });
    if (!response.ok) return {};
    const rate = Number((await response.json())?.[USDT_COIN_ID]?.[PRICE_CURRENCY]);
    return Number.isFinite(rate) && rate > 0 ? { [RATE_KEYS.USDT]: rate } : {};
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
    // Some tables do not create the id automatically. In that case, choose the next free id.
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

function describeResult({ tradeCount, openingCount, cashChanges, notes, stopMessage }) {
  const parts = [];
  if (tradeCount > 0) parts.push(`${tradeCount} ${tradeCount === 1 ? 'trade' : 'trades'} recorded`);
  if (openingCount > 0) parts.push(`${openingCount} ${openingCount === 1 ? 'sale' : 'sales'} had no earlier purchase in the history, so those coins were counted at the sale price (no profit or loss)`);
  if (cashChanges > 0) parts.push(`${cashChanges} cash ${cashChanges === 1 ? 'balance' : 'balances'} synced`);
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

    const [tradeRows, importedRows, positionRows, balances, marketPrices] = await Promise.all([
      database.select('broker_trades', 'select=*&order=traded_at.asc,external_id.asc'),
      database.select('transactions', 'select=external_id&external_id=not.is.null'),
      database.select('portfolio', 'select=*&order=id.asc'),
      database.select('broker_balances', 'select=broker,asset,qty'),
      loadUsdtRate(fetchImpl),
    ]);

    const positions = positionRows.map(toPosition);
    const originals = new Map(positions.map((position) => [keyOf(position), position]));
    const trades = tradeRows.map((row) => ({
      externalId: row.external_id, broker: row.broker, asset: row.asset, side: row.side,
      qty: Number(row.qty), cashAmount: Number(row.cash_amount), feeQuote: Number(row.fee_quote),
      quoteCurrency: row.quote_currency, tradedAt: Date.parse(row.traded_at),
    }));
    const newTrades = findNewTrades({ trades, importedIds: importedRows.map((row) => row.external_id) });

    // Trades go in with the broker cash left alone, because the cash is set to the broker's balance below.
    const tradePlan = planTradeImport({ trades: newTrades, positions, marketPrices, useCash: false });
    const cashPlan = planCashAlignment({
      positions: tradePlan.positions,
      balances: balances.map((row) => ({ broker: row.broker, asset: row.asset, qty: Number(row.qty) })),
      syncedBrokers,
      marketPrices,
      tradeDate: toTradeDate(now().getTime()),
    });

    const records = [...tradePlan.records, ...cashPlan.records];
    let failure = '';
    if (records.length > 0) failure = await commit(database, { originals, finalPositions: cashPlan.positions, records });

    outcome = failure
      ? { broker: LEDGER_STATUS_NAME, ok: false, message: failure }
      : {
          broker: LEDGER_STATUS_NAME,
          ok: true,
          message: describeResult({ tradeCount: tradePlan.importedIds.length, openingCount: tradePlan.openingCount, cashChanges: cashPlan.records.length, notes: cashPlan.notes, stopMessage: tradePlan.message }),
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
