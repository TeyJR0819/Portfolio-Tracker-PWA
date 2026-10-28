// Cloudflare Worker entry point.
// Static files in public/ are served by Cloudflare directly. Only /api/* requests reach this code.

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
};
