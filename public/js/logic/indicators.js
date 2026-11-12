// Indicator maths for the chart. Pure functions: no browser features are used here.
// Every function takes plain arrays and returns an array of the same length.
// A position holds null while there is not enough data yet.

export function sma(values, period) {
  const result = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) result[i] = sum / period;
  }
  return result;
}

// Exponential moving average, started from the simple average of the first period.
export function ema(values, period) {
  const result = new Array(values.length).fill(null);
  if (values.length < period) return result;

  const weight = 2 / (period + 1);
  let previous = values.slice(0, period).reduce((total, value) => total + value, 0) / period;
  result[period - 1] = previous;
  for (let i = period; i < values.length; i += 1) {
    previous = values[i] * weight + previous * (1 - weight);
    result[i] = previous;
  }
  return result;
}

// Relative Strength Index with Wilder's smoothing, the same method TradingView uses.
export function rsi(closes, period = 14) {
  const result = new Array(closes.length).fill(null);
  if (closes.length <= period) return result;

  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const change = closes[i] - closes[i - 1];
    if (change >= 0) gain += change;
    else loss -= change;
  }
  gain /= period;
  loss /= period;
  result[period] = toRsi(gain, loss);

  for (let i = period + 1; i < closes.length; i += 1) {
    const change = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + Math.max(change, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-change, 0)) / period;
    result[i] = toRsi(gain, loss);
  }
  return result;
}

function toRsi(gain, loss) {
  if (loss === 0) return gain === 0 ? 50 : 100;
  return 100 - 100 / (1 + gain / loss);
}

// Bollinger Bands: the average and a band of "multiplier" standard deviations on each side.
export function bollinger(values, period = 20, multiplier = 2) {
  const middle = sma(values, period);
  const upper = new Array(values.length).fill(null);
  const lower = new Array(values.length).fill(null);

  for (let i = period - 1; i < values.length; i += 1) {
    let squares = 0;
    for (let j = i - period + 1; j <= i; j += 1) squares += (values[j] - middle[i]) ** 2;
    const deviation = Math.sqrt(squares / period);
    upper[i] = middle[i] + multiplier * deviation;
    lower[i] = middle[i] - multiplier * deviation;
  }
  return { upper, middle, lower };
}

// MACD: fast average minus slow average, a signal line, and the gap between them (the histogram).
export function macd(values, fast = 12, slow = 26, signalPeriod = 9) {
  const fastLine = ema(values, fast);
  const slowLine = ema(values, slow);
  const line = values.map((_, i) => (fastLine[i] === null || slowLine[i] === null ? null : fastLine[i] - slowLine[i]));

  const firstIndex = line.findIndex((value) => value !== null);
  const signal = new Array(values.length).fill(null);
  if (firstIndex >= 0) {
    const smoothed = ema(line.slice(firstIndex), signalPeriod);
    smoothed.forEach((value, i) => {
      signal[firstIndex + i] = value;
    });
  }
  const histogram = line.map((value, i) => (value === null || signal[i] === null ? null : value - signal[i]));
  return { line, signal, histogram };
}
