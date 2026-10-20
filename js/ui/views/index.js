// Maps each tab name to the function that draws it.
// To add a tab: write a view file, add its panel and button in index.html, then list it here.

import { renderCashView } from './cash-view.js';
import { renderCryptoView } from './crypto-view.js';
import { renderMmfView } from './mmf-view.js';
import { renderStocksView } from './stocks-view.js';
import { renderSummaryView } from './summary-view.js';

export const VIEWS = Object.freeze({
  summary: renderSummaryView,
  cash: renderCashView,
  stocks: renderStocksView,
  mmf: renderMmfView,
  crypto: renderCryptoView,
});
