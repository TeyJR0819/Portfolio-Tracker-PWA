// Cloudflare Worker entry point.
// Static files in public/ are served by Cloudflare directly. Only /api/* requests reach this code.

import { runBrokerSync } from './brokers/sync.js';
import { runLedgerSync } from './ledger-sync.js';
import { handleStocksRequest } from './stocks.js';

// Gives the page the two public Supabase values, so visitors need not type them.
// Both are public by design (the database rules, not secrecy, protect the data).
// The service key and the broker keys are never included. Without both values the route is absent.
// Minutes 7, 22, 37 and 52 of every hour. The broker reads run at 0, 15, 30 and 45.
export const LEDGER_CRON = '7-59/15 * * * *';

export function handleConfigRequest(env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return Response.json({ error: 'Not found.' }, { status: 404 });
  return Response.json(
    { databaseUrl: env.SUPABASE_URL.trim().replace(/\/+$/, ''), databaseKey: env.SUPABASE_ANON_KEY.trim() },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (pathname === '/api/stocks' && request.method === 'GET') {
      return handleStocksRequest({ request, env });
    }
    if (pathname === '/api/config' && request.method === 'GET') {
      return handleConfigRequest(env);
    }
    if (pathname.startsWith('/api/')) {
      return Response.json({ error: 'Not found.' }, { status: 404 });
    }
    return env.ASSETS.fetch(request);
  },

  // Runs on the cron schedules in wrangler.toml. There is no web address that starts a sync,
  // so nobody can trigger it or read broker data through the Worker.
  // Two schedules keep each run within Cloudflare's limit on outgoing requests:
  //   LEDGER_CRON  records new trades in the ledger and syncs cash
  //   any other    reads the brokers
  async scheduled(event, env, context) {
    const run = event.cron === LEDGER_CRON ? runLedgerSync(env).then((outcome) => [outcome]) : runBrokerSync(env);
    context.waitUntil(
      run.then((outcomes) => {
        if (outcomes.length === 0) console.log('sync: nothing was due in this run.');
        for (const outcome of outcomes) console.log(`sync ${outcome.broker}: ${outcome.ok ? `ok ${outcome.message}` : outcome.message}`);
      }),
    );
  },
};
