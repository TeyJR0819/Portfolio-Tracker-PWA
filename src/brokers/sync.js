// Scheduled job: reads each broker with its read-only key and stores the balances in Supabase.
// The browser never sees a broker key. It only reads the stored balances.
//
// Secrets (set with "wrangler secret put" or in the Cloudflare dashboard, never in this repo):
//   SUPABASE_URL, SUPABASE_SERVICE_KEY            writes to the database
//   LUNO_KEY_ID, LUNO_KEY_SECRET                  Luno, "View balance" only
//   PIONEX_API_KEY, PIONEX_API_SECRET             Pionex, "Read" only
//   IBKR_FLEX_TOKEN, IBKR_FLEX_QUERY_ID           Interactive Brokers Flex Web Service (read-only report)
// Optional plain variable: IBKR_ALWAYS = "true" reads IBKR on every run (for the first test only).

import { fetchIbkrBalances } from './ibkr.js';
import { fetchLunoBalances } from './luno.js';
import { fetchPionexBalances } from './pionex.js';

const BALANCES_TABLE = 'broker_balances';
const STATUS_TABLE = 'broker_sync_status';

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
  },
  {
    name: 'Pionex',
    isConfigured: (env) => Boolean(env.PIONEX_API_KEY && env.PIONEX_API_SECRET),
    read: (env, fetchImpl) => fetchPionexBalances({ apiKey: env.PIONEX_API_KEY, apiSecret: env.PIONEX_API_SECRET, fetchImpl }),
  },
  {
    name: 'IBKR',
    isConfigured: (env) => Boolean(env.IBKR_FLEX_TOKEN && env.IBKR_FLEX_QUERY_ID),
    isDue: isIbkrDue,
    read: (env, fetchImpl) => fetchIbkrBalances({ token: env.IBKR_FLEX_TOKEN, queryId: env.IBKR_FLEX_QUERY_ID, fetchImpl }),
  },
]);

function createDatabase(env, fetchImpl) {
  const origin = env.SUPABASE_URL.replace(/\/+$/, '');
  // Legacy service keys are JWTs and also go in Authorization. New "sb_secret_" keys go in apikey only.
  const headers = { apikey: env.SUPABASE_SERVICE_KEY, 'Content-Type': 'application/json' };
  if (env.SUPABASE_SERVICE_KEY.startsWith('eyJ')) headers.Authorization = `Bearer ${env.SUPABASE_SERVICE_KEY}`;

  async function send(path, init) {
    const response = await fetchImpl(`${origin}/rest/v1/${path}`, { ...init, headers: { ...headers, ...init.headers } });
    if (!response.ok) throw new Error(`Database answered with status ${response.status}.`);
  }

  return {
    upsert: (table, rows, conflictColumns) =>
      send(`${table}?on_conflict=${conflictColumns}`, {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(rows),
      }),
    // Removes rows of one broker that this run did not return (for example a sold-out asset).
    deleteOlder: (table, broker, syncedAt) =>
      send(`${table}?broker=eq.${encodeURIComponent(broker)}&synced_at=lt.${encodeURIComponent(syncedAt)}`, {
        method: 'DELETE',
        headers: { Prefer: 'return=minimal' },
      }),
  };
}

// One broker failing never stops the others. Messages carry a status code only, never a key.
export async function runBrokerSync(env, { fetchImpl = fetch, now = () => new Date() } = {}) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) return [{ broker: 'all', ok: false, message: 'Database secrets are missing.' }];

  const database = createDatabase(env, fetchImpl);
  const outcomes = [];

  const runTime = now();
  const due = BROKERS.filter((candidate) => candidate.isConfigured(env) && (candidate.isDue?.(env, runTime) ?? true));
  for (const broker of due) {
    const syncedAt = now().toISOString();
    try {
      const balances = await broker.read(env, fetchImpl);
      const rows = balances.map(({ asset, qty }) => ({ broker: broker.name, asset, qty, synced_at: syncedAt }));
      if (rows.length > 0) await database.upsert(BALANCES_TABLE, rows, 'broker,asset');
      await database.deleteOlder(BALANCES_TABLE, broker.name, syncedAt);
      await database.upsert(STATUS_TABLE, [{ broker: broker.name, ok: true, message: '', synced_at: syncedAt }], 'broker');
      outcomes.push({ broker: broker.name, ok: true, message: '' });
    } catch (error) {
      const message = String(error.message ?? 'Unknown error.').slice(0, 200);
      outcomes.push({ broker: broker.name, ok: false, message });
      try {
        await database.upsert(STATUS_TABLE, [{ broker: broker.name, ok: false, message, synced_at: syncedAt }], 'broker');
      } catch {
        // The status line cannot be saved either. The Worker log still shows the outcome.
      }
    }
  }
  return outcomes;
}
