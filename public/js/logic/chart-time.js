// Converts between a moment in time and a position on the chart, counted in candles.
// A drawing stores a real time and price, so it stays in place when the timeframe changes.
// Position 0 is the first candle, 1 the second, and so on. Fractions fall between candles.
// Times before the first candle and after the last one continue at the same candle length.
// Pure functions: no browser features are used here.

// times: candle times in seconds, sorted from old to new.
export function timeToPosition(times, time) {
  const count = times.length;
  if (count === 0) return 0;
  if (count === 1) return 0;

  if (time <= times[0]) return (time - times[0]) / (times[1] - times[0]);
  if (time >= times[count - 1]) return count - 1 + (time - times[count - 1]) / (times[count - 1] - times[count - 2]);

  let low = 0;
  let high = count - 1;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (times[middle] <= time) low = middle;
    else high = middle;
  }
  return low + (time - times[low]) / (times[high] - times[low]);
}

export function positionToTime(times, position) {
  const count = times.length;
  if (count === 0) return 0;
  if (count === 1) return times[0];

  if (position <= 0) return times[0] + position * (times[1] - times[0]);
  if (position >= count - 1) return times[count - 1] + (position - (count - 1)) * (times[count - 1] - times[count - 2]);

  const low = Math.floor(position);
  return times[low] + (position - low) * (times[low + 1] - times[low]);
}
