// Reads Pionex from GitHub Actions instead of the Cloudflare Worker.
// Pionex answers the shared address of Cloudflare Workers with a 429, so the same read-only code runs from here.
// It needs only these four secrets, set as GitHub repository secrets (never in a file):
//   SUPABASE_URL, SUPABASE_SERVICE_KEY, PIONEX_API_KEY, PIONEX_API_SECRET
import { runBrokerSync } from '../src/brokers/sync.js';

const env = {
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY,
  PIONEX_API_KEY: process.env.PIONEX_API_KEY,
  PIONEX_API_SECRET: process.env.PIONEX_API_SECRET,
  SYNC_ALWAYS: 'true', // Only Pionex is configured here, so this reads only Pionex, once per workflow run.
};

const outcomes = await runBrokerSync(env);
for (const outcome of outcomes) console.log(`${outcome.broker}: ${outcome.ok ? 'ok' : 'failed'} ${outcome.message}`);
if (outcomes.some((outcome) => !outcome.ok)) process.exitCode = 1;
