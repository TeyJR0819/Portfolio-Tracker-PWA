// Asks our own Worker for the public Supabase details.
// Returns { databaseUrl, databaseKey }, or null when the Worker has none (local use, GitHub Pages).

import { CONFIG_API_PATH } from '../config.js';
import { isValidDatabaseUrl } from './auth.js';

const REQUEST_TIMEOUT_MS = 5000;

export async function loadSharedConfig() {
  try {
    const response = await fetch(CONFIG_API_PATH, { cache: 'no-store', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!response.ok) return null;
    const { databaseUrl, databaseKey } = await response.json();
    if (!isValidDatabaseUrl(databaseUrl) || typeof databaseKey !== 'string' || databaseKey.length < 20) return null;
    return { databaseUrl, databaseKey };
  } catch {
    return null;
  }
}
