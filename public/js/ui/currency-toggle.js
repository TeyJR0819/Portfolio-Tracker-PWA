// The RM / USD switch in the header. It only changes how amounts are shown, not what is stored.

import { byId } from './dom.js';

export function initCurrencyToggle({ onChange }) {
  byId('currency-toggle').addEventListener('click', (event) => {
    const button = event.target.closest('[data-currency]');
    if (button && !button.disabled) onChange(button.dataset.currency);
  });
}

// shown: the currency on screen. hasRate: false disables USD, because no rate is known yet.
export function renderCurrencyToggle({ shown, hasRate }) {
  byId('currency-toggle')
    .querySelectorAll('[data-currency]')
    .forEach((button) => {
      const isUsd = button.dataset.currency === 'USD';
      button.setAttribute('aria-pressed', String(button.dataset.currency === shown));
      button.disabled = isUsd && !hasRate;
      button.title = isUsd && !hasRate ? 'The USD rate is not available yet. Press Refresh.' : '';
    });
}
