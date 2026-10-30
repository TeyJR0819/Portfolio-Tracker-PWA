// Turns one executed trade from any broker into one row for the broker_trades table.
// The row is already in ledger terms, so the app needs no broker-specific rules:
//   qty          units that arrive (buy, after any fee taken in the asset) or leave (sell)
//   cash_amount  money that left (buy, fee included) or arrived (sell, after the fee), in the quote currency
//   fee_quote    the fee counted in the quote currency, for display

const DECIMALS = 8;
const round = (value) => Number(value.toFixed(DECIMALS));

// Coins the app tracks. Trades of any other coin are not read.
export const TRADED_ASSETS = Object.freeze(['BTC', 'ETH', 'ADA', 'LINK', 'SUI', 'TON']);

// side: 'buy' or 'sell'. baseQty and quoteAmount are the traded quantity and its value before fees.
// feeBase is a fee charged in the asset, feeQuote a fee charged in the quote currency.
// Returns null for a trade that cannot be recorded (zero or negative amounts).
export function toTradeRow({ externalId, broker, asset, side, baseQty, quoteAmount, feeBase = 0, feeQuote = 0, quoteCurrency, tradedAt }) {
  const price = baseQty > 0 ? quoteAmount / baseQty : 0;
  const isBuy = side === 'buy';
  const qty = isBuy ? baseQty - feeBase : baseQty;
  const feeInQuote = isBuy ? feeQuote : feeQuote + feeBase * price;
  const cashAmount = isBuy ? quoteAmount + feeQuote : quoteAmount - feeInQuote;

  const values = [qty, cashAmount, feeInQuote, tradedAt];
  if (!externalId || !values.every(Number.isFinite) || qty <= 0 || cashAmount <= 0) return null;

  return {
    external_id: externalId,
    broker,
    asset,
    side,
    qty: round(qty),
    cash_amount: round(cashAmount),
    fee_quote: round(feeInQuote),
    quote_currency: quoteCurrency,
    traded_at: new Date(tradedAt).toISOString(),
  };
}
