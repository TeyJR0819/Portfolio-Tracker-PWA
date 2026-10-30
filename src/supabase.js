// A small Supabase REST client for the Worker. It uses the service key, which skips Row Level Security,
// so it must only run here, on Cloudflare, and never in the browser.
//
// Errors carry .status (HTTP) and .code (the database error code, for example 23505 for a duplicate).
// Messages never include the key.

const PAGE_SIZE = 1000;

export function createDatabase(env, fetchImpl) {
  const origin = env.SUPABASE_URL.replace(/\/+$/, '');
  // Legacy service keys are JWTs and also go in Authorization. New "sb_secret_" keys go in apikey only.
  const headers = { apikey: env.SUPABASE_SERVICE_KEY, 'Content-Type': 'application/json' };
  if (env.SUPABASE_SERVICE_KEY.startsWith('eyJ')) headers.Authorization = `Bearer ${env.SUPABASE_SERVICE_KEY}`;

  async function send(path, init = {}) {
    const response = await fetchImpl(`${origin}/rest/v1/${path}`, { ...init, headers: { ...headers, ...init.headers } });
    if (response.ok) return response.status === 204 ? null : response.json().catch(() => null);

    const body = await response.json().catch(() => ({}));
    const error = new Error(`Database answered with status ${response.status}.`);
    error.status = response.status;
    error.code = body?.code ?? '';
    error.detail = String(body?.message ?? '').slice(0, 150);
    throw error;
  }

  const represent = { Prefer: 'return=representation' };

  return {
    // Reads every row. query is the part after the table name, for example "select=*&order=id".
    async select(table, query = 'select=*') {
      const rows = [];
      for (let offset = 0; ; offset += PAGE_SIZE) {
        const page = (await send(`${table}?${query}&limit=${PAGE_SIZE}&offset=${offset}`)) ?? [];
        rows.push(...page);
        if (page.length < PAGE_SIZE) return rows;
      }
    },
    // Inserts rows and returns them with their ids.
    insert: (table, rows) => send(table, { method: 'POST', headers: represent, body: JSON.stringify(rows) }),
    // Changes the rows that match filter (for example "id=eq.5") and returns them.
    update: (table, filter, changes) => send(`${table}?${filter}`, { method: 'PATCH', headers: represent, body: JSON.stringify(changes) }),
    remove: (table, filter) => send(`${table}?${filter}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } }),
    upsert: (table, rows, conflictColumns) =>
      send(`${table}?on_conflict=${conflictColumns}`, {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(rows),
      }),
    // Removes rows of one broker that this run did not return (for example a sold-out asset).
    deleteOlder: (table, broker, syncedAt) => send(`${table}?broker=eq.${encodeURIComponent(broker)}&synced_at=lt.${encodeURIComponent(syncedAt)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } }),
  };
}
