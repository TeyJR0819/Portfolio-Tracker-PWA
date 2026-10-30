// Connection status: the chip in the header, the warning banner and the loading indicators.

import { listPriceFallbacks } from '../logic/calculations.js';
import { formatTime } from '../logic/format.js';
import { byId, createElement } from './dom.js';

function buildChip(state) {
  const { priceInfo, dataInfo } = state;

  if (!priceInfo) return { tone: 'busy', text: 'Loading prices' };
  if (dataInfo?.isOffline) return { tone: 'warning', text: `Saved copy from ${formatTime(dataInfo.savedAt)}` };
  if (priceInfo.status === 'partial') return { tone: 'warning', text: 'Some prices are old' };
  if (priceInfo.status === 'failed') {
    const text = priceInfo.updatedAt ? `Old prices from ${formatTime(priceInfo.updatedAt)}` : 'Prices unavailable';
    return { tone: 'warning', text };
  }
  return { tone: 'ok', text: `Prices updated ${formatTime(priceInfo.updatedAt)}` };
}

function buildNotices(state, holdings) {
  const notices = [];
  const { priceInfo, dataInfo } = state;

  if (dataInfo?.isOffline) {
    notices.push(
      `Supabase cannot be reached (${dataInfo.errorMessage}). You are viewing the copy saved at ${formatTime(dataInfo.savedAt)}. Adding transactions is paused.`,
    );
  }
  if (dataInfo && !dataInfo.isOffline && state.positions.length === 0) {
    notices.push(
      'Supabase returned no rows from the table "portfolio". If the table has data, a Row Level Security policy is blocking the read (see the README). Otherwise, choose Add entry to enter your first holding, or import your broker trades from the Summary tab.',
    );
  }
  if (priceInfo?.status === 'failed') {
    notices.push(`Live prices are unavailable (${priceInfo.errorMessage}). The last saved prices are used.`);
  }

  if (priceInfo?.status === 'partial') {
    notices.push(`Some prices could not be updated (${priceInfo.errorMessage}). Their last saved prices are used.`);
  }

  const fallbacks = listPriceFallbacks(holdings);
  if (fallbacks.length > 0) {
    notices.push(`No market price for ${fallbacks.join(', ')}. These assets are valued at their average cost.`);
  }
  return notices;
}

export function renderStatus(state, holdings) {
  const chip = byId('sync-status');
  const { tone, text } = buildChip(state);
  chip.dataset.tone = tone;
  byId('sync-status-text').textContent = text;

  const banner = byId('notice-banner');
  const notices = buildNotices(state, holdings);
  banner.replaceChildren(...notices.map((notice) => createElement('p', { text: notice })));
  banner.hidden = notices.length === 0;
}

export function setFetching(isFetching) {
  byId('loading-bar').hidden = !isFetching;
  document.querySelectorAll('[data-action="refresh"]').forEach((button) => {
    button.disabled = isFetching;
  });
}

export function finishInitialLoad() {
  document.body.classList.remove('is-initial-load');
}

export function showDataError(message) {
  byId('data-error-message').textContent = message;
  byId('data-error').hidden = false;
}

export function hideDataError() {
  byId('data-error').hidden = true;
}

export function showFatalError(message) {
  const box = byId('fatal-error');
  box.textContent = message;
  box.hidden = false;
  document.body.classList.remove('is-initial-load');
}
