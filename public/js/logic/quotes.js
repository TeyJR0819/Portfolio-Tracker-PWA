// Turns the answer of the stock quote function into RM prices. Pure logic, no browser features.
//
// The function answers with prices in each stock's own currency and the exchange rates to RM:
//   { quotes: { VOO: { price: 600, currency: 'USD' } }, fx: { USD: 4.2 } }

import { RATE_KEYS } from '../config.js';

function isUsable(value) {
  return Number.isFinite(value) && value > 0;
}

// fallbackUsdRate is used only when the function could not provide a USD rate.
export function convertQuotesToMyr(payload, fallbackUsdRate = null) {
  const prices = {};
  const fx = { ...(payload?.fx ?? {}), MYR: 1 };
  if (!isUsable(fx.USD) && isUsable(fallbackUsdRate)) fx.USD = fallbackUsdRate;

  for (const [symbol, quote] of Object.entries(payload?.quotes ?? {})) {
    const rate = fx[quote?.currency];
    if (isUsable(quote?.price) && isUsable(rate)) prices[symbol] = quote.price * rate;
  }

  if (isUsable(payload?.fx?.USD)) prices[RATE_KEYS.USD] = payload.fx.USD;
  return prices;
}
