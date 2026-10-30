// Cloudflare Worker entry point.
// Static files in public/ are served by Cloudflare directly. Only /api/* requests reach this code.

import { runBrokerSync } from './brokers/sync.js';
import { handleStocksRequest } from './stocks.js';

// Gives the page the two public Supabase values, so visitors need not type them.
// Both are public by design (the database rules, not secrecy, protect the data).
// The service key and the broker keys are never included. Without both values the route is absent.
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

  // Runs on the cron schedule in wrangler.toml. There is no web address that starts a sync,
  // so nobody can trigger it or read broker data through the Worker.
  async scheduled(event, env, context) {
    context.waitUntil(
      runBrokerSync(env).then((outcomes) => {
        for (const outcome of outcomes) console.log(`sync ${outcome.broker}: ${outcome.ok ? 'ok' : outcome.message}`);
      }),
    );
  },
};
