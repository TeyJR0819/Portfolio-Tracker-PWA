// Scheduled job: reads each broker with its read-only key and stores the balances in Supabase.
// The browser never sees a broker key. It only reads the stored balances.
//
// Secrets (set with "wrangler secret put" or in the Cloudflare dashboard, never in this repo):
//   SUPABASE_URL, SUPABASE_SERVICE_KEY            writes to the database
//   LUNO_KEY_ID, LUNO_KEY_SECRET                  Luno, "View balance" only
//   PIONEX_API_KEY, PIONEX_API_SECRET             Pionex, "Read" only
//   IBKR_FLEX_TOKEN, IBKR_FLEX_QUERY_ID           Interactive Brokers Flex Web Service (read-only report)
// Optional plain variable: TRADES_BACKFILL = "true" reads the full trade history once (first-time import).
// Optional plain variable: IBKR_ALWAYS = "true" reads IBKR on every run (for the first test only).

import { createDatabase } from '../supabase.js';
import { fetchIbkrBalances } from './ibkr.js';
import { fetchLunoBalances, fetchLunoTrades } from './luno.js';
import { fetchPionexBalances, fetchPionexTrades } from './pionex.js';

const BALANCES_TABLE = 'broker_balances';
const STATUS_TABLE = 'broker_sync_status';
const TRADES_TABLE = 'broker_trades';
const TRADES_BATCH_SIZE = 200;
const RECENT_PAGES = 1; // Every run reads the newest 100 trades of each coin.
const BACKFILL_PAGES = 5; // With TRADES_BACKFILL="true", it reads up to 500 trades per coin (first-time import).

// IBKR reports the last business day, so it is read once every few hours, in the first run of that hour.
const IBKR_EVERY_HOURS = 6;
const RUN_MINUTES = 15; // Matches the cron schedule in wrangler.toml.
function isIbkrDue(env, now) {
  if (env.IBKR_ALWAYS === 'true') return true;
  return now.getUTCHours() % IBKR_EVERY_HOURS === 0 && now.getUTCMinutes() < RUN_MINUTES;
}

const BROKERS = Object.freeze([
  {
    name: 'Luno',
    isConfigured: (env) => Boolean(env.LUNO_KEY_ID && env.LUNO_KEY_SECRET),
    read: (env, fetchImpl) => fetchLunoBalances({ keyId: env.LUNO_KEY_ID, keySecret: env.LUNO_KEY_SECRET, fetchImpl }),
    readTrades: (env, fetchImpl, pages) => fetchLunoTrades({ keyId: env.LUNO_KEY_ID, keySecret: env.LUNO_KEY_SECRET, fetchImpl, pages }),
  },
  {
    name: 'Pionex',
    isConfigured: (env) => Boolean(env.PIONEX_API_KEY && env.PIONEX_API_SECRET),
    read: (env, fetchImpl) => fetchPionexBalances({ apiKey: env.PIONEX_API_KEY, apiSecret: env.PIONEX_API_SECRET, fetchImpl }),
    readTrades: (env, fetchImpl, pages, wait) => fetchPionexTrades({ apiKey: env.PIONEX_API_KEY, apiSecret: env.PIONEX_API_SECRET, fetchImpl, pages, wait }),
  },
  {
    name: 'IBKR',
    isConfigured: (env) => Boolean(env.IBKR_FLEX_TOKEN && env.IBKR_FLEX_QUERY_ID),
    isDue: isIbkrDue,
    read: (env, fetchImpl) => fetchIbkrBalances({ token: env.IBKR_FLEX_TOKEN, queryId: env.IBKR_FLEX_QUERY_ID, fetchImpl }),
  },
]);

// Saves the trades of a broker that offers them. A trade problem never marks the balances as failed.
// Returns a short note for the status line ('' when all is well).
async function syncTrades(broker, env, fetchImpl, database, wait) {
  if (!broker.readTrades) return '';
  try {
    const pages = env.TRADES_BACKFILL === 'true' ? BACKFILL_PAGES : RECENT_PAGES;
    const trades = await broker.readTrades(env, fetchImpl, pages, wait);
    for (let start = 0; start < trades.length; start += TRADES_BATCH_SIZE) {
      await database.upsert(TRADES_TABLE, trades.slice(start, start + TRADES_BATCH_SIZE), 'external_id');
    }
    return trades.isLimited ? 'Trades: Pionex rate limit reached. The rest follows in the next run.' : '';
  } catch (error) {
    return `Trades: ${String(error.message ?? 'Unknown error.').slice(0, 150)}`;
  }
}

// One broker failing never stops the others. Messages carry a status code only, never a key.
export async function runBrokerSync(env, { fetchImpl = fetch, now = () => new Date(), wait } = {}) {
  const missing = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY'].filter((name) => !env[name]);
  if (missing.length > 0) return [{ broker: 'all', ok: false, message: `Missing secrets: ${missing.join(', ')}.` }];

  const database = createDatabase(env, fetchImpl);
  const outcomes = [];

  const runTime = now();
  if (!BROKERS.some((candidate) => candidate.isConfigured(env))) return [{ broker: 'all', ok: false, message: 'No broker secrets are set.' }];
  const due = BROKERS.filter((candidate) => candidate.isConfigured(env) && (candidate.isDue?.(env, runTime) ?? true));
  for (const broker of due) {
    const syncedAt = now().toISOString();
    try {
      const balances = await broker.read(env, fetchImpl);
      const rows = balances.map(({ asset, qty }) => ({ broker: broker.name, asset, qty, synced_at: syncedAt }));
      if (rows.length > 0) await database.upsert(BALANCES_TABLE, rows, 'broker,asset');
      await database.deleteOlder(BALANCES_TABLE, broker.name, syncedAt);
      const tradeNote = await syncTrades(broker, env, fetchImpl, database, wait);
      await database.upsert(STATUS_TABLE, [{ broker: broker.name, ok: true, message: tradeNote, synced_at: syncedAt }], 'broker');
      outcomes.push({ broker: broker.name, ok: true, message: tradeNote });
    } catch (error) {
      const message = String(error.message ?? 'Unknown error.').slice(0, 200);
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
