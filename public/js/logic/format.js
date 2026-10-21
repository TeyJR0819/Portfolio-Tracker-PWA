// Text formatting for numbers shown on screen.

const decimalFormatters = new Map();

function getFormatter(decimals) {
  if (!decimalFormatters.has(decimals)) {
    decimalFormatters.set(
      decimals,
      new Intl.NumberFormat('en-MY', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }),
    );
  }
  return decimalFormatters.get(decimals);
}

// Turns tiny values and negative zero into a clean zero.
function clean(value, decimals) {
  const number = Number.isFinite(value) ? value : 0;
  return Math.abs(number) < 0.5 * 10 ** -decimals ? 0 : number;
}

export function formatNumber(value, decimals = 2) {
  return getFormatter(decimals).format(clean(value, decimals));
}

export function formatRm(value) {
  const number = clean(value, 2);
  return `${number < 0 ? '-' : ''}RM ${formatNumber(Math.abs(number), 2)}`;
}

// Amount in a foreign currency, for example "USD 1,250.00".
export function formatForeign(value, currencyCode) {
  return `${currencyCode} ${formatNumber(value, 2)}`;
}

export function formatSignedRm(value) {
  const number = clean(value, 2);
  return `${number > 0 ? '+' : ''}${formatRm(number)}`;
}

export function formatPercent(value) {
  const number = clean(value, 2);
  return `${number > 0 ? '+' : ''}${formatNumber(number, 2)}%`;
}

export function formatQuantity(value, decimals = 6) {
  return formatNumber(value, decimals);
}

export function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString('en-MY', { hour: '2-digit', minute: '2-digit' });
}

export function getTone(value) {
  const number = clean(value, 2);
  if (number > 0) return 'positive';
  if (number < 0) return 'negative';
  return 'neutral';
}
