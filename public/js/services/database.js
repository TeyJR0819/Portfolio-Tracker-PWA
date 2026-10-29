// All communication with Supabase lives in this file.
// Database columns use snake_case; the rest of the app uses camelCase.
// The two functions toPosition and toDatabaseRow translate between them.

import { BROKER_BALANCES_TABLE, BROKER_SYNC_STATUS_TABLE, DATABASE_TABLE, STORAGE_KEYS, TRANSACTIONS_LIMIT, TRANSACTIONS_TABLE } from '../config.js';
import { localStore } from './storage.js';

let client = null;

// One client per URL and key. Creating several on the same page makes Supabase warn
// about "multiple GoTrueClient instances".
const clientCache = new Map();

function createDatabaseClient({ databaseUrl, databaseKey }) {
  if (!window.supabase?.createClient) {
    throw new Error('The Supabase library did not load. Check your internet connection and reload.');
  }

  const url = databaseUrl.trim().replace(/\/+$/, '');
  const key = databaseKey.trim();
  const cacheKey = `${url}|${key}`;

  if (!clientCache.has(cacheKey)) {
    clientCache.set(
      cacheKey,
      window.supabase.createClient(url, key, {
        // The sign-in session is kept so the person does not log in again after every visit.
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: false,
          storageKey: STORAGE_KEYS.authSession,
        },
      }),
    );
  }
  return clientCache.get(cacheKey);
}

function getClient() {
  if (!client) throw new Error('The database is not connected yet.');
  return client;
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function toPosition(row) {
  return {
    id: row.id,
    category: row.category,
    broker: row.broker,
    asset: row.asset,
    qty: toNumber(row.qty),
    costMyr: toNumber(row.cost_myr),
    realisedPl: toNumber(row.realised_pl),
  };
}

function toDatabaseRow(position) {
  return {
    category: position.category,
    broker: position.broker,
    asset: position.asset,
    qty: position.qty,
    cost_myr: position.costMyr,
    realised_pl: position.realisedPl,
  };
}

function toTransaction(row) {
  return {
    id: row.id,
    tradeDate: row.trade_date,
    kind: row.kind,
    broker: row.broker ?? '',
    asset: row.asset ?? '',
    qty: toNumber(row.qty),
    price: toNumber(row.price),
    currency: row.currency ?? 'MYR',
    fee: toNumber(row.fee),
    rate: toNumber(row.rate) || 1,
    totalMyr: toNumber(row.total_myr),
    fromAccount: row.from_account ?? '',
    toAccount: row.to_account ?? '',
    amountFrom: toNumber(row.amount_from),
    amountTo: toNumber(row.amount_to),
    realisedPl: toNumber(row.realised_pl),
    note: row.note ?? '',
  };
}

function toTransactionRow(record) {
  return {
    trade_date: record.tradeDate,
    kind: record.kind,
    broker: record.broker,
    asset: record.asset,
    qty: record.qty,
    price: record.price,
    currency: record.currency,
    fee: record.fee,
    rate: record.rate,
    total_myr: record.totalMyr,
    from_account: record.fromAccount,
    to_account: record.toAccount,
    amount_from: record.amountFrom,
    amount_to: record.amountTo,
    realised_pl: record.realisedPl,
    note: record.note,
  };
}

// True when the sign-in session is missing or expired (not when the anon key is wrong).
function isAuthError(error) {
  return error?.code === 'PGRST301' || /jwt expired|jwt is expired/i.test(String(error?.message ?? ''));
}

// An Error whose message a person can read. isAuthError tells the app to ask for the sign-in again.
function toFailure(error) {
  const failure = new Error(describeDatabaseError(error));
  failure.isAuthError = isAuthError(error);
  return failure;
}

// Turns a technical error into a sentence a person can act on.
export function describeDatabaseError(error) {
  const message = String(error?.message ?? error ?? '');
  const code = error?.code;

  if (/failed to fetch|networkerror|load failed/i.test(message)) {
    return 'Cannot reach Supabase. Check your internet connection and the project URL.';
  }
  if (isAuthError(error)) {
    return 'Your sign-in has expired. Sign in again.';
  }
  if (/invalid api key|jwt/i.test(message) || code === '401') {
    return 'Supabase rejected the anon key. Reset the credentials and enter the key again.';
  }
  if (code === '42P01') {
    return 'The table "portfolio" was not found in this Supabase project.';
  }
  if (code === '42501' || /row-level security/i.test(message)) {
    return 'Supabase blocked this request. Add a Row Level Security policy for the portfolio table (see README).';
  }
  if (code === 'PGRST116') {
    return 'Supabase did not apply the change. Check that the Row Level Security policy allows updates (see README).';
  }
  return message || 'An unknown database error occurred.';
}

export function connectDatabase(credentials) {
  client = createDatabaseClient(credentials);
}

// ---------- Sign-in ----------
// The database only answers a signed-in owner (see the Row Level Security policies in the README).

function describeAuthError(error) {
  const message = String(error?.message ?? '');
  if (/invalid login credentials/i.test(message)) return 'The email or password is not correct.';
  if (error?.status === 429 || /rate limit|too many/i.test(message)) return 'Too many attempts. Wait a few minutes and try again.';
  if (/email not confirmed/i.test(message)) return 'This email is not confirmed. Confirm it in Supabase, Authentication, Users.';
  if (/failed to fetch|networkerror|load failed/i.test(message)) return 'Cannot reach Supabase. Check your internet connection.';
  return message || 'Sign-in failed.';
}

// Returns the current session, or null when the person is not signed in.
export async function getSession() {
  const { data, error } = await getClient().auth.getSession();
  return error ? null : data.session;
}

export async function signIn(email, password) {
  const { error } = await getClient().auth.signInWithPassword({ email, password });
  if (error) throw new Error(describeAuthError(error));
}

// Ends the sign-in on this device and removes the saved copy of the data.
export async function signOut() {
  try {
    await getClient().auth.signOut({ scope: 'local' });
  } catch {
    // The local session is removed below even when the server cannot be reached.
  }
  localStore.remove(STORAGE_KEYS.authSession);
  localStore.remove(STORAGE_KEYS.positionsSnapshot);
}

// Used by the setup wizard to check the details before saving them.
export async function testConnection(credentials) {
  try {
    const { error } = await createDatabaseClient(credentials).from(DATABASE_TABLE).select('id').limit(1);
    if (error) throw error;
    return { ok: true, message: '' };
  } catch (error) {
    return { ok: false, message: describeDatabaseError(error) };
  }
}

// Keeps the offline copy in step with changes made on this device.
export function cachePositions(positions) {
  localStore.setJson(STORAGE_KEYS.positionsSnapshot, { savedAt: Date.now(), positions });
}

// Loads all positions. When the network fails, the last saved copy is returned instead.
export async function loadPositions() {
  try {
    const { data, error } = await getClient().from(DATABASE_TABLE).select('*').order('id', { ascending: true });
    if (error) throw error;

    const positions = data.map(toPosition);
    const savedAt = Date.now();
    localStore.setJson(STORAGE_KEYS.positionsSnapshot, { savedAt, positions });
    return { positions, isOffline: false, savedAt, errorMessage: '' };
  } catch (error) {
    // An expired sign-in must never fall back to the saved copy.
    if (isAuthError(error)) throw toFailure(error);

    const snapshot = localStore.getJson(STORAGE_KEYS.positionsSnapshot);
    if (snapshot?.positions) {
      return {
        positions: snapshot.positions,
        isOffline: true,
        savedAt: snapshot.savedAt,
        errorMessage: describeDatabaseError(error),
      };
    }
    throw toFailure(error);
  }
}

async function insertPosition(position) {
  let result = await getClient().from(DATABASE_TABLE).insert(toDatabaseRow(position)).select().single();

  // Some tables do not create the id automatically. In that case, choose the next free id.
  if (result.error?.code === '23502' && /"id"/.test(result.error.message)) {
    const latest = await getClient().from(DATABASE_TABLE).select('id').order('id', { ascending: false }).limit(1);
    const nextId = (latest.data?.[0]?.id ?? 0) + 1;
    result = await getClient()
      .from(DATABASE_TABLE)
      .insert({ id: nextId, ...toDatabaseRow(position) })
      .select()
      .single();
  }

  if (result.error) throw toFailure(result.error);
  return toPosition(result.data);
}

async function updatePosition(position) {
  const row = toDatabaseRow(position);
  const { data, error } = await getClient()
    .from(DATABASE_TABLE)
    .update({ qty: row.qty, cost_myr: row.cost_myr, realised_pl: row.realised_pl })
    .eq('id', position.id)
    .select()
    .single();

  if (error) throw toFailure(error);
  return toPosition(data);
}

// Creates the row when the position is new, otherwise updates it. Returns the saved position.
export function savePosition(position) {
  return position.id === null || position.id === undefined ? insertPosition(position) : updatePosition(position);
}

// ---------- Transactions (the history shown on the Transactions page) ----------

function describeTransactionsError(error) {
  const message = String(error?.message ?? error ?? '');
  if (error?.code === 'PGRST205' || error?.code === '42P01' || /could not find the table/i.test(message)) {
    return 'The "transactions" table does not exist yet. Run the SQL in the README (section "Transactions table"), then press Refresh.';
  }
  if (error?.code === '42501' || /row-level security/i.test(message)) {
    return 'Supabase blocked the "transactions" table. Add the policies from the README (section "Transactions table").';
  }
  return describeDatabaseError(error);
}

// Never throws: the dashboard still works when the history cannot be loaded.
export async function loadTransactions() {
  try {
    const { data, error } = await getClient()
      .from(TRANSACTIONS_TABLE)
      .select('*')
      .order('trade_date', { ascending: false })
      .order('id', { ascending: false })
      .limit(TRANSACTIONS_LIMIT);
    if (error) throw error;
    return { transactions: data.map(toTransaction), errorMessage: '' };
  } catch (error) {
    return { transactions: [], errorMessage: describeTransactionsError(error) };
  }
}

// Reads what the Worker saved from the brokers. Never throws: the dashboard works without it.
// An empty result means the sync is not set up yet (or the tables do not exist).
export async function loadBrokerSync() {
  try {
    const [balances, statuses] = await Promise.all([
      getClient().from(BROKER_BALANCES_TABLE).select('broker, asset, qty'),
      getClient().from(BROKER_SYNC_STATUS_TABLE).select('broker, ok, message, synced_at'),
    ]);
    if (balances.error) throw balances.error;
    if (statuses.error) throw statuses.error;
    return {
      balances: balances.data.map((row) => ({ broker: row.broker, asset: row.asset, qty: toNumber(row.qty) })),
      statuses: statuses.data.map((row) => ({ broker: row.broker, ok: row.ok, message: row.message, syncedAt: row.synced_at })),
    };
  } catch {
    return { balances: [], statuses: [] };
  }
}

async function insertTransaction(record) {
  const { data, error } = await getClient().from(TRANSACTIONS_TABLE).insert(toTransactionRow(record)).select().single();
  if (error) throw error;
  return toTransaction(data);
}

// Puts balances back to how they were before a failed entry. A row that was created by the
// entry is set to zero, because the app has no permission to delete rows.
async function restorePositions(savedSteps) {
  try {
    for (const { before, saved } of [...savedSteps].reverse()) {
      const original = before.id === null ? { ...before, id: saved.id, qty: 0, costMyr: 0, realisedPl: 0 } : before;
      await updatePosition(original);
    }
    return true;
  } catch {
    return false;
  }
}

// Saves every changed balance and then the history line.
//   changes: [{ before, after }] from the ledger
// If a balance fails to save, the earlier ones are restored, so a buy never leaves the asset
// changed but the cash untouched.
// The history line is saved last. If only that fails, the balances stay saved and logError says why.
export async function saveEntry({ changes, record }) {
  const savedSteps = [];

  try {
    for (const { before, after } of changes) {
      savedSteps.push({ before, saved: await savePosition(after) });
    }
  } catch (error) {
    const wasRestored = await restorePositions(savedSteps);
    throw new Error(
      wasRestored
        ? `${error.message} Nothing was changed.`
        : `${error.message} Some balances were already changed and could not be restored. Press Refresh and check them.`,
    );
  }

  const positions = savedSteps.map((step) => step.saved);
  try {
    return { positions, transaction: await insertTransaction(record), logError: '' };
  } catch (error) {
    return { positions, transaction: null, logError: describeTransactionsError(error) };
  }
}
