// All communication with Supabase lives in this file.
// Database columns use snake_case; the rest of the app uses camelCase.
// The two functions toPosition and toDatabaseRow translate between them.

import { DATABASE_TABLE, STORAGE_KEYS, TRANSACTIONS_LIMIT, TRANSACTIONS_TABLE } from '../config.js';
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
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
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

// Turns a technical error into a sentence a person can act on.
export function describeDatabaseError(error) {
  const message = String(error?.message ?? error ?? '');
  const code = error?.code;

  if (/failed to fetch|networkerror|load failed/i.test(message)) {
    return 'Cannot reach Supabase. Check your internet connection and the project URL.';
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
    const snapshot = localStore.getJson(STORAGE_KEYS.positionsSnapshot);
    if (snapshot?.positions) {
      return {
        positions: snapshot.positions,
        isOffline: true,
        savedAt: snapshot.savedAt,
        errorMessage: describeDatabaseError(error),
      };
    }
    throw new Error(describeDatabaseError(error));
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

  if (result.error) throw new Error(describeDatabaseError(result.error));
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

  if (error) throw new Error(describeDatabaseError(error));
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
