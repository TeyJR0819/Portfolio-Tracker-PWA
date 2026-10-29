// Cloudflare Worker entry point.
// Static files in public/ are served by Cloudflare directly. Only /api/* requests reach this code.

import { runBrokerSync } from './brokers/sync.js';
import { handleStocksRequest } from './stocks.js';

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (pathname === '/api/stocks' && request.method === 'GET') {
      return handleStocksRequest({ request, env });
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
