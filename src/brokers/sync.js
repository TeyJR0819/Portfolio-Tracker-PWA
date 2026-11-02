// Scheduled job: reads each broker with its read-only key and stores the balances in Supabase.
// The browser never sees a broker key. It only reads the stored balances.
//
// Secrets (set with "wrangler secret put" or in the Cloudflare dashboard, never in this repo):
//   SUPABASE_URL, SUPABASE_SERVICE_KEY            writes to the database
//   LUNO_KEY_ID, LUNO_KEY_SECRET                  Luno, "View balance" + "View orders" + "View transactions"
//   PIONEX_API_KEY, PIONEX_API_SECRET             Pionex, "Read" only
//   IBKR_FLEX_TOKEN, IBKR_FLEX_QUERY_ID           Interactive Brokers Flex Web Service (read-only report)
// Optional plain variable: TRADES_BACKFILL = "true" reads the FULL trade + transfer history (first-time import).
// Optional plain variable: SYNC_ALWAYS = "true" reads IBKR and Pionex on every run (for tests only).

import { createDatabase } from '../supabase.js';
import { fetchIbkrBalances } from './ibkr.js';
import { fetchLunoBalances, fetchLunoTrades, fetchLunoTransfers } from './luno.js';
import { fetchPionexBalances, fetchPionexEarnBalances, fetchPionexTrades } from './pionex.js';

const BALANCES_TABLE = 'broker_balances';
const STATUS_TABLE = 'broker_sync_status';
const TRADES_TABLE = 'broker_trades';
const TRADES_BATCH_SIZE = 200;
const OBSOLETE_BATCH_SIZE = 50; // Keeps the delete address short.

// pages = 1 reads the newest 100 trades per coin per run (normal operation).
// pages = 0 reads ALL available history page by page (backfill mode, unlimited).
const RECENT_PAGES = 1;
const BACKFILL_PAGES = 0; // 0 = unlimited; keep fetching until Luno/Pionex return a partial page.

// IBKR reports the last business day, so it is read once every few hours, in the first run of that hour.
// Pionex is read once an hour.
const IBKR_EVERY_HOURS = 6;
const RUN_MINUTES = 15; // Matches the cron schedule in wrangler.toml.
function isFirstRunOfHour(now) {
  return now.getUTCMinutes() < RUN_MINUTES;
}
function isIbkrDue(env, now) {
  if (env.IBKR_ALWAYS === 'true' || env.SYNC_ALWAYS === 'true') return true;
  return now.getUTCHours() % IBKR_EVERY_HOURS === 0 && isFirstRunOfHour(now);
}
// Pionex limits requests per account and per address. Once an hour keeps the Worker well below both.
// A failed read (for example a 429 from the address the Worker shares with others) is tried again in the next
// 15-minute run, so one blocked minute never leaves Pionex unread for a whole hour.
function isPionexDue(env, now, failedBrokers = new Set()) {
  return env.SYNC_ALWAYS === 'true' || isFirstRunOfHour(now) || failedBrokers.has('Pionex');
}

const BROKERS = Object.freeze([
  {
    name: 'Luno',
    isConfigured: (env) => Boolean(env.LUNO_KEY_ID && env.LUNO_KEY_SECRET),
    read: (env, fetchImpl) => fetchLunoBalances({ keyId: env.LUNO_KEY_ID, keySecret: env.LUNO_KEY_SECRET, fetchImpl }),
    readTrades: (env, fetchImpl, pages) => fetchLunoTrades({ keyId: env.LUNO_KEY_ID, keySecret: env.LUNO_KEY_SECRET, fetchImpl, pages }),
    // Transfers are read separately so a failure here never blocks the trade sync.
    readTransfers: (env, fetchImpl, pages, wait) => fetchLunoTransfers({ keyId: env.LUNO_KEY_ID, keySecret: env.LUNO_KEY_SECRET, fetchImpl, pages, wait }),
  },
  {
    name: 'Pionex',
    isConfigured: (env) => Boolean(env.PIONEX_API_KEY && env.PIONEX_API_SECRET),
    isDue: isPionexDue,
    // Trading-account coins plus the Earn money. Bots stay out. Both are read, or the whole read fails.
    read: async (env, fetchImpl, wait) => {
      const credentials = { apiKey: env.PIONEX_API_KEY, apiSecret: env.PIONEX_API_SECRET, fetchImpl, wait };
      const totals = new Map();
      for (const { asset, qty } of [...(await fetchPionexBalances(credentials)), ...(await fetchPionexEarnBalances(credentials))]) {
        totals.set(asset, (totals.get(asset) ?? 0) + qty);
      }
      return [...totals].filter(([, qty]) => qty !== 0).map(([asset, qty]) => ({ asset, qty }));
    },
    readTrades: (env, fetchImpl, pages, wait) => fetchPionexTrades({ apiKey: env.PIONEX_API_KEY, apiSecret: env.PIONEX_API_SECRET, fetchImpl, pages, wait }),
  },
  {
    name: 'IBKR',
    isConfigured: (env) => Boolean(env.IBKR_FLEX_TOKEN && env.IBKR_FLEX_QUERY_ID),
    isDue: isIbkrDue,
    read: (env, fetchImpl) => fetchIbkrBalances({ token: env.IBKR_FLEX_TOKEN, queryId: env.IBKR_FLEX_QUERY_ID, fetchImpl }),
  },
]);

// One short line for a full read: how many rows came back and the staking reward total per coin.
// Compare these totals with the Luno app. They are the reward amounts the ledger will record.
function describeFullRead(rows) {
  const rewards = new Map();
  for (const row of rows) {
    if (row.side === 'staking_reward') rewards.set(row.asset, (rewards.get(row.asset) ?? 0) + Number(row.qty));
  }
  const text = [...rewards].map(([asset, qty]) => `${asset} ${Number(qty.toFixed(6))}`).join(', ');
  return `Full Luno history read: ${rows.length} rows. Staking rewards: ${text || 'none'}.`;
}

// Saves the trades of a broker that offers them. A trade problem never marks the balances as failed.
// Returns a short note for the status line ('' when all is well).
async function syncTrades(broker, env, fetchImpl, database, wait) {
  if (!broker.readTrades) return '';
  const notes = [];
  try {
    const pages = env.TRADES_BACKFILL === 'true' ? BACKFILL_PAGES : RECENT_PAGES;
    const trades = await broker.readTrades(env, fetchImpl, pages, wait);
    for (let start = 0; start < trades.length; start += TRADES_BATCH_SIZE) {
      await database.upsert(TRADES_TABLE, trades.slice(start, start + TRADES_BATCH_SIZE), 'external_id');
    }
    if (trades.isLimited) {
      notes.push(`Pionex rate limit reached (${trades.limitDetail}). The rest follows in the next run.`);
    }
  } catch (error) {
    notes.push(`Trades: ${String(error.message ?? 'Unknown error.').slice(0, 150)}`);
  }

  // Also sync on-chain transfers, instant buys and staking rewards for Luno.
  if (broker.readTransfers) {
    try {
      const isFullRead = env.TRADES_BACKFILL === 'true';
      const transfers = await broker.readTransfers(env, fetchImpl, isFullRead ? BACKFILL_PAGES : RECENT_PAGES, wait);

      // Old rows that are no longer produced (for example an internal staking move that was once read as a reward) are
      // removed, but ONLY after a full read. A normal run sees just the newest rows, so every older row would look
      // "obsolete" and be deleted, and the ledger would then be rebuilt from a shortened history.
      if (isFullRead) {
        const currentIds = new Set(transfers.map((row) => row.external_id));
        try {
          const existing = await database.select(TRADES_TABLE, 'select=external_id&broker=eq.Luno');
          const obsoleteIds = existing
            .map((r) => r.external_id)
            .filter((id) => id && (id.startsWith('luno:transfer:') || id.startsWith('luno:inflow:') || id.startsWith('luno:reward:') || id.startsWith('luno:txfee:')) && !currentIds.has(id));
          for (let start = 0; start < obsoleteIds.length; start += OBSOLETE_BATCH_SIZE) {
            await database.remove(TRADES_TABLE, `external_id=in.(${obsoleteIds.slice(start, start + OBSOLETE_BATCH_SIZE).join(',')})`);
          }
        } catch {
          // Non-fatal if cleanup query is skipped in a minimal mock
        }
      }
      for (let start = 0; start < transfers.length; start += TRADES_BATCH_SIZE) {
        await database.upsert(TRADES_TABLE, transfers.slice(start, start + TRADES_BATCH_SIZE), 'external_id');
      }
      if (isFullRead) notes.push(describeFullRead(transfers));
    } catch (error) {
      notes.push(`Transfers: ${String(error.message ?? 'Unknown error.').slice(0, 120)}`);
    }
  }

  return notes.join(' ');
}

// One broker failing never stops the others. Messages carry a status code only, never a key.
export async function runBrokerSync(env, { fetchImpl = fetch, now = () => new Date(), wait } = {}) {
  const missing = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY'].filter((name) => !env[name]);
  if (missing.length > 0) return [{ broker: 'all', ok: false, message: `Missing secrets: ${missing.join(', ')}.` }];

  const database = createDatabase(env, fetchImpl);
  const outcomes = [];

  const runTime = now();
  if (!BROKERS.some((candidate) => candidate.isConfigured(env))) return [{ broker: 'all', ok: false, message: 'No broker secrets are set.' }];
  let failedBrokers = new Set();
  try {
    const statuses = await database.select(STATUS_TABLE, 'select=broker,ok');
    failedBrokers = new Set(statuses.filter((status) => status.ok === false).map((status) => status.broker));
  } catch {
    // Without the status lines the normal schedule applies.
  }
  const due = BROKERS.filter((candidate) => candidate.isConfigured(env) && (candidate.isDue?.(env, runTime, failedBrokers) ?? true));
  for (const broker of due) {
    const syncedAt = now().toISOString();
    try {
      const balances = await broker.read(env, fetchImpl, wait);
      const rows = balances.map(({ asset, qty }) => ({ broker: broker.name, asset, qty, synced_at: syncedAt }));
      if (rows.length > 0) await database.upsert(BALANCES_TABLE, rows, 'broker,asset');
      await database.deleteOlder(BALANCES_TABLE, broker.name, syncedAt);
      const tradeNote = await syncTrades(broker, env, fetchImpl, database, wait);
      await database.upsert(STATUS_TABLE, [{ broker: broker.name, ok: true, message: tradeNote, synced_at: syncedAt }], 'broker');
      outcomes.push({ broker: broker.name, ok: true, message: tradeNote });
    } catch (error) {
      const message = String(error.message ?? 'Unknown error.').slice(0, 300);
      outcomes.push({ broker: broker.name, ok: false, message });
      try {
        await database.upsert(STATUS_TABLE, [{ broker: broker.name, ok: false, message, synced_at: syncedAt }], 'broker');
      } catch {
        // The status line cannot be saved either (for example a wrong service key). The Worker log shows it.
        outcomes.push({ broker: `${broker.name} (status)`, ok: false, message: 'The sync status could not be saved to the database. Check SUPABASE_URL and SUPABASE_SERVICE_KEY.' });
      }
    }
  }
  return outcomes;
}
