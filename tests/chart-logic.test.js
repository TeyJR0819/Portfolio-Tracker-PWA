import assert from 'node:assert/strict';
import { test } from 'node:test';

import { bollinger, ema, macd, rsi, sma } from '../public/js/logic/indicators.js';
import { positionToTime, timeToPosition } from '../public/js/logic/chart-time.js';
import { buildShape, distanceToSegment, hitTest, moveDrawing, sanitiseDrawings } from '../public/js/logic/chart-drawings.js';

const close = (a, b, tolerance = 1e-6) => assert.ok(Math.abs(a - b) <= tolerance, `${a} is not close to ${b}`);

test('sma averages the last period values', () => {
  assert.deepEqual(sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
});

test('ema starts from the simple average and then weights new values', () => {
  const result = ema([1, 2, 3, 4, 5], 3);
  assert.deepEqual(result.slice(0, 2), [null, null]);
  close(result[2], 2);
  close(result[3], 3); // 4 * 0.5 + 2 * 0.5
  close(result[4], 4);
});

test('rsi matches a known Wilder example and stays between 0 and 100', () => {
  // Classic worked example (14 period) from Wilder's method: a steadily rising series gives 100.
  const rising = Array.from({ length: 30 }, (_, i) => 100 + i);
  assert.equal(rsi(rising, 14)[29], 100);
  const falling = Array.from({ length: 30 }, (_, i) => 100 - i);
  assert.equal(rsi(falling, 14)[29], 0);

  const closes = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.0, 46.03, 46.41, 46.22, 45.64];
  const values = rsi(closes, 14);
  close(values[14], 70.46, 0.05); // published value for the first RSI of this series
  assert.ok(values.slice(14).every((value) => value >= 0 && value <= 100));
  assert.equal(values[13], null);
});

test('rsi of a flat series is 50', () => {
  assert.equal(rsi(new Array(20).fill(10), 14)[19], 50);
});

test('bollinger bands surround the average by two deviations', () => {
  const { upper, middle, lower } = bollinger([2, 4, 4, 4, 5, 5, 7, 9], 8, 2);
  close(middle[7], 5);
  close(upper[7], 9); // standard deviation of this set is 2
  close(lower[7], 1);
  assert.equal(upper[6], null);
});

test('macd histogram is the line minus the signal', () => {
  const values = Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i / 5) * 10 + i * 0.2);
  const { line, signal, histogram } = macd(values);
  const index = 60;
  close(histogram[index], line[index] - signal[index]);
  assert.equal(line[24], null);
  assert.notEqual(line[25], null);
  assert.equal(histogram[25], null);
});

test('time and position convert back and forth, inside and beyond the candles', () => {
  const times = [1000, 1060, 1120, 1180];
  assert.equal(timeToPosition(times, 1090), 1.5);
  assert.equal(positionToTime(times, 1.5), 1090);
  assert.equal(timeToPosition(times, 1240), 4); // one candle after the last
  assert.equal(positionToTime(times, 5), 1300);
  assert.equal(timeToPosition(times, 940), -1);
  assert.equal(positionToTime(times, -2), 880);
  for (const time of [900, 1000, 1033, 1180, 1500]) close(positionToTime(times, timeToPosition(times, time)), time);
});

test('time positions skip weekend gaps, so a line keeps its place between candles', () => {
  const times = [0, 86400, 4 * 86400]; // a three-day gap after the second candle
  assert.equal(timeToPosition(times, 86400), 1);
  assert.equal(timeToPosition(times, 4 * 86400), 2);
  assert.equal(timeToPosition(times, 2.5 * 86400), 1.5);
});

const identity = (point) => ({ x: point.time, y: point.price });
const trend = { id: 'a', type: 'trend', color: '#d9b26f', points: [{ time: 0, price: 0 }, { time: 100, price: 100 }] };
const level = { id: 'b', type: 'hline', color: '#d9b26f', points: [{ time: 50, price: 20 }] };

test('a click near a line selects it and a click far away does not', () => {
  assert.equal(hitTest([trend], identity, 500, 50, 52)?.drawing.id, 'a');
  assert.equal(hitTest([trend], identity, 500, 50, 80), null);
  assert.equal(distanceToSegment(0, 10, [0, 0, 10, 0]), 10);
});

test('a handle is found before the line, and a horizontal line spans the chart', () => {
  assert.deepEqual(hitTest([trend], identity, 500, 2, 1), { drawing: trend, handleIndex: 0 });
  assert.equal(hitTest([level], identity, 500, 400, 21)?.drawing.id, 'b');
  assert.equal(buildShape(level, identity, 500).segments[0][2], 500);
});

test('a ray continues past its second point to the right edge', () => {
  const ray = { ...trend, id: 'r', type: 'ray' };
  const [segment] = buildShape(ray, identity, 500).segments;
  assert.equal(segment[2], 550);
  assert.equal(segment[3], 550);
});

test('a fibonacci drawing has seven level lines plus its guide', () => {
  const fib = { ...trend, id: 'f', type: 'fib' };
  const shape = buildShape(fib, identity, 500);
  assert.equal(shape.levels.length, 7);
  assert.equal(shape.segments.length, 8);
  assert.equal(shape.levels[0].y, 100);
  assert.equal(shape.levels[6].y, 0);
});

test('moving a drawing shifts every point, and moving a handle changes one', () => {
  const moved = moveDrawing(trend, -1, 10, 5);
  assert.deepEqual(moved.points, [{ time: 10, price: 5 }, { time: 110, price: 105 }]);
  const handle = moveDrawing(trend, 1, 0, 0, { time: 200, price: 300 });
  assert.deepEqual(handle.points, [{ time: 0, price: 0 }, { time: 200, price: 300 }]);
});

test('saved drawings are cleaned before use', () => {
  const clean = sanitiseDrawings([
    trend,
    { id: 'x', type: 'unknown', color: '#fff', points: [] },
    { id: 'y', type: 'hline', color: 'red', points: [{ time: 1, price: 2 }] },
    { id: 'z', type: 'trend', color: '#112233', points: [{ time: 1, price: 2 }] },
    null,
  ]);
  assert.deepEqual(clean.map((item) => item.id), ['a', 'y']);
  assert.equal(clean[1].color, '#d9b26f');
  assert.deepEqual(sanitiseDrawings('nonsense'), []);
});
