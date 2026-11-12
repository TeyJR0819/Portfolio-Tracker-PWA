// The candlestick chart itself, built with TradingView's Lightweight Charts library.
// It owns the chart, the candles and the indicators. Drawings are added by drawing-controller.js.
//
// Indicators that share the price scale (volume, averages, Bollinger Bands) sit on the main pane.
// RSI and MACD each get their own pane below it, as on TradingView.

import { DISPLAY_TIME_ZONE } from '../../config.js';
import { bollinger, ema, macd, rsi, sma } from '../../logic/indicators.js';
import { positionToTime, timeToPosition } from '../../logic/chart-time.js';
import { readCssVariable } from '../dom.js';

const COLORS = Object.freeze({
  sma: '#60a5fa',
  ema: '#f59e0b',
  bollinger: '#a78bfa',
  rsi: '#c084fc',
  macdLine: '#60a5fa',
  macdSignal: '#f59e0b',
});

const MAIN_PANE_SHARE = 4;
const SUB_PANE_SHARE = 1.4;

function pricePrecision(price) {
  if (price >= 1) return 2;
  if (price >= 0.01) return 4;
  if (price >= 0.0001) return 6;
  return 8;
}

function formatClock(seconds, withTime) {
  const options = withTime
    ? { timeZone: DISPLAY_TIME_ZONE, day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }
    : { timeZone: DISPLAY_TIME_ZONE, day: '2-digit', month: 'short', year: 'numeric' };
  return new Intl.DateTimeFormat('en-GB', options).format(new Date(seconds * 1000));
}

function formatTick(seconds, tickType, withTime) {
  const zone = { timeZone: DISPLAY_TIME_ZONE };
  const date = new Date(seconds * 1000);
  // tickType: 0 year, 1 month, 2 day of month, 3 time, 4 time with seconds.
  if (tickType === 0) return new Intl.DateTimeFormat('en-GB', { ...zone, year: 'numeric' }).format(date);
  if (tickType === 1) return new Intl.DateTimeFormat('en-GB', { ...zone, month: 'short' }).format(date);
  if (tickType === 2 || !withTime) return new Intl.DateTimeFormat('en-GB', { ...zone, day: 'numeric', month: 'short' }).format(date);
  return new Intl.DateTimeFormat('en-GB', { ...zone, hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}

export function createChartEngine(container, { legendElement }) {
  const lib = window.LightweightCharts;
  const text = readCssVariable('--color-text-muted');
  const border = readCssVariable('--color-border');
  const positive = readCssVariable('--color-positive');
  const negative = readCssVariable('--color-negative');

  let candles = [];
  let times = [];
  let intradayLabels = true;
  let indicatorSeries = []; // every series added for an indicator, so they can be removed together
  let indicatorValues = []; // { name, series, format } used by the legend
  let averageCostLine = null;
  let legendLabel = '';

  const chart = lib.createChart(container, {
    autoSize: true,
    layout: {
      background: { type: 'solid', color: 'transparent' },
      textColor: text,
      fontFamily: readCssVariable('--font-sans'),
      attributionLogo: true,
      panes: { separatorColor: border, separatorHoverColor: border, enableResize: true },
    },
    grid: { vertLines: { color: 'rgba(148, 163, 184, 0.07)' }, horzLines: { color: 'rgba(148, 163, 184, 0.07)' } },
    crosshair: { mode: lib.CrosshairMode.Normal },
    rightPriceScale: { borderColor: border, scaleMargins: { top: 0.08, bottom: 0.08 } },
    timeScale: {
      borderColor: border,
      timeVisible: true,
      secondsVisible: false,
      rightOffset: 8,
      tickMarkFormatter: (time, tickType) => formatTick(time, tickType, intradayLabels),
    },
    localization: { timeFormatter: (time) => formatClock(time, intradayLabels) },
  });

  const candleSeries = chart.addSeries(
    lib.CandlestickSeries,
    {
      upColor: positive,
      downColor: negative,
      wickUpColor: positive,
      wickDownColor: negative,
      borderVisible: false,
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    },
    0,
  );

  // ---------- Legend ----------

  function span(textValue, className = '') {
    const element = document.createElement('span');
    if (className) element.className = className;
    element.textContent = textValue;
    return element;
  }

  function renderLegend(candle, values = new Map()) {
    legendElement.replaceChildren();
    const head = span(legendLabel, 'chart-legend-name');
    legendElement.append(head);
    if (!candle) return;

    const format = (value) => candleSeries.priceFormatter().format(value);
    const change = candle.close - candle.open;
    const percent = candle.open ? (change / candle.open) * 100 : 0;
    const tone = change >= 0 ? 'is-positive' : 'is-negative';
    legendElement.append(
      span(`O ${format(candle.open)}`),
      span(`H ${format(candle.high)}`),
      span(`L ${format(candle.low)}`),
      span(`C ${format(candle.close)}`),
      span(`${change >= 0 ? '+' : ''}${format(change)} (${change >= 0 ? '+' : ''}${percent.toFixed(2)}%)`, tone),
    );
    if (candle.volume > 0) legendElement.append(span(`Vol ${Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 2 }).format(candle.volume)}`));

    for (const entry of indicatorValues) {
      const value = values.get(entry.series) ?? entry.last;
      if (value !== undefined && value !== null) legendElement.append(span(`${entry.name} ${entry.format(value)}`, 'chart-legend-indicator'));
    }
  }

  chart.subscribeCrosshairMove((param) => {
    const index = param.time === undefined ? -1 : times.indexOf(param.time);
    if (index < 0) {
      renderLegend(candles[candles.length - 1]);
      return;
    }
    const values = new Map();
    for (const entry of indicatorValues) {
      const data = param.seriesData.get(entry.series);
      if (data && data.value !== undefined) values.set(entry.series, data.value);
    }
    renderLegend(candles[index], values);
  });

  // ---------- Indicators ----------

  function clearIndicators() {
    for (const series of indicatorSeries) {
      try {
        chart.removeSeries(series);
      } catch {
        // The series is already gone.
      }
    }
    indicatorSeries = [];
    indicatorValues = [];
  }

  function lineData(values) {
    return times.map((time, index) => (values[index] === null ? { time } : { time, value: values[index] }));
  }

  function lastValue(values) {
    for (let i = values.length - 1; i >= 0; i -= 1) if (values[i] !== null) return values[i];
    return undefined;
  }

  function addLine(values, { color, paneIndex, name, decimals = null, width = 1.5, dashed = false }) {
    const series = chart.addSeries(
      lib.LineSeries,
      {
        color,
        lineWidth: width,
        lineStyle: dashed ? lib.LineStyle.Dashed : lib.LineStyle.Solid,
        priceLineVisible: false,
        lastValueVisible: paneIndex > 0,
        crosshairMarkerVisible: false,
      },
      paneIndex,
    );
    series.setData(lineData(values));
    indicatorSeries.push(series);
    if (name) {
      const format = (value) => (decimals === null ? candleSeries.priceFormatter().format(value) : value.toFixed(decimals));
      indicatorValues.push({ name, series, format, last: lastValue(values) });
    }
    return series;
  }

  // config: { volume, sma: { on, period }, ema, bollinger, rsi, macd: { on } }
  function applyIndicators(config) {
    clearIndicators();
    if (candles.length === 0) return;
    const closes = candles.map((candle) => candle.close);
    let nextPane = 1;

    if (config.volume && candles.some((candle) => candle.volume > 0)) {
      const volume = chart.addSeries(
        lib.HistogramSeries,
        { priceFormat: { type: 'volume' }, priceScaleId: 'volume', lastValueVisible: false, priceLineVisible: false },
        0,
      );
      volume.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      volume.setData(
        candles.map((candle) => ({ time: candle.time, value: candle.volume, color: candle.close >= candle.open ? 'rgba(52, 211, 153, 0.35)' : 'rgba(248, 113, 113, 0.35)' })),
      );
      indicatorSeries.push(volume);
    }

    if (config.sma.on) addLine(sma(closes, config.sma.period), { color: COLORS.sma, paneIndex: 0, name: `SMA ${config.sma.period}` });
    if (config.ema.on) addLine(ema(closes, config.ema.period), { color: COLORS.ema, paneIndex: 0, name: `EMA ${config.ema.period}` });
    if (config.bollinger.on) {
      const bands = bollinger(closes, config.bollinger.period, 2);
      addLine(bands.upper, { color: COLORS.bollinger, paneIndex: 0, name: `BB upper`, width: 1 });
      addLine(bands.middle, { color: COLORS.bollinger, paneIndex: 0, width: 1, dashed: true });
      addLine(bands.lower, { color: COLORS.bollinger, paneIndex: 0, name: 'BB lower', width: 1 });
    }

    if (config.rsi.on) {
      const pane = nextPane;
      nextPane += 1;
      const line = addLine(rsi(closes, config.rsi.period), { color: COLORS.rsi, paneIndex: pane, name: `RSI ${config.rsi.period}`, decimals: 1 });
      line.applyOptions({ autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }), priceFormat: { type: 'price', precision: 1, minMove: 0.1 } });
      for (const [level, label] of [[70, 'Overbought'], [30, 'Oversold']]) {
        line.createPriceLine({ price: level, color: 'rgba(148, 163, 184, 0.6)', lineWidth: 1, lineStyle: lib.LineStyle.Dashed, axisLabelVisible: true, title: label });
      }
    }

    if (config.macd.on) {
      const pane = nextPane;
      nextPane += 1;
      const result = macd(closes, 12, 26, 9);
      const histogram = chart.addSeries(lib.HistogramSeries, { priceLineVisible: false, lastValueVisible: false, priceFormat: { type: 'price', precision: 4, minMove: 0.0001 } }, pane);
      histogram.setData(
        times.map((time, index) => {
          const value = result.histogram[index];
          return value === null ? { time } : { time, value, color: value >= 0 ? 'rgba(52, 211, 153, 0.6)' : 'rgba(248, 113, 113, 0.6)' };
        }),
      );
      indicatorSeries.push(histogram);
      addLine(result.line, { color: COLORS.macdLine, paneIndex: pane, name: 'MACD', decimals: 4 });
      addLine(result.signal, { color: COLORS.macdSignal, paneIndex: pane, name: 'Signal', decimals: 4 });
    }

    const panes = chart.panes();
    panes.forEach((pane, index) => pane.setStretchFactor(index === 0 ? MAIN_PANE_SHARE : SUB_PANE_SHARE));
    renderLegend(candles[candles.length - 1]);
  }

  // ---------- Data ----------

  let lastIndicatorConfig = null;

  // label: the text at the start of the legend, for example "Bitcoin - 1h - USD".
  function setData(nextCandles, { label, intraday, indicators }) {
    candles = nextCandles;
    times = nextCandles.map((candle) => candle.time);
    intradayLabels = intraday;
    legendLabel = label;
    lastIndicatorConfig = indicators;

    const lastClose = candles[candles.length - 1]?.close ?? 1;
    const precision = pricePrecision(lastClose);
    candleSeries.applyOptions({ priceFormat: { type: 'price', precision, minMove: 10 ** -precision } });
    candleSeries.setData(candles);
    applyIndicators(indicators);
    chart.timeScale().fitContent();
    chart.timeScale().applyOptions({ rightOffset: 8 });
    // Show the most recent part of long histories, as TradingView does.
    const total = candles.length;
    if (total > 120) chart.timeScale().setVisibleLogicalRange({ from: total - 120, to: total + 8 });
  }

  // Refreshes the latest candles without moving the view. Returns false when the data does not continue
  // the current candles (another asset or timeframe), so the caller can use setData instead.
  function refreshData(nextCandles) {
    const lastTime = times[times.length - 1];
    if (times.length === 0 || !nextCandles.some((candle) => candle.time === lastTime)) return false;

    const range = chart.timeScale().getVisibleLogicalRange();
    const dropped = Math.max(0, times.indexOf(nextCandles[0].time)); // old candles that left the front of the history
    const appended = nextCandles.length - (times.length - dropped); // new candles added at the end
    const wasAtLiveEdge = range ? range.to >= times.length - 1 : false;

    candles = nextCandles;
    times = nextCandles.map((candle) => candle.time);
    candleSeries.setData(candles);
    applyIndicators(lastIndicatorConfig);

    if (range) {
      const forward = wasAtLiveEdge ? appended : 0;
      chart.timeScale().setVisibleLogicalRange({ from: range.from - dropped + forward, to: range.to - dropped + forward });
    }
    return true;
  }

  function setIndicators(config) {
    lastIndicatorConfig = config;
    applyIndicators(config);
  }

  function setAverageCost(price, title) {
    if (averageCostLine) {
      candleSeries.removePriceLine(averageCostLine);
      averageCostLine = null;
    }
    if (Number.isFinite(price) && price > 0) {
      averageCostLine = candleSeries.createPriceLine({
        price,
        color: readCssVariable('--color-accent'),
        lineWidth: 1,
        lineStyle: lib.LineStyle.LargeDashed,
        axisLabelVisible: true,
        title,
      });
    }
  }

  // ---------- Coordinates (used by the drawing tools) ----------

  function project(point) {
    const x = chart.timeScale().logicalToCoordinate(timeToPosition(times, point.time));
    const y = candleSeries.priceToCoordinate(point.price);
    return { x: x ?? Number.NaN, y: y ?? Number.NaN };
  }

  function unproject(x, y) {
    const logical = chart.timeScale().coordinateToLogical(x);
    const price = candleSeries.coordinateToPrice(y);
    if (logical === null || price === null) return null;
    return { time: Math.round(positionToTime(times, logical)), price };
  }

  // Snaps a point to the open, high, low or close of the nearest candle when it is close enough.
  function snap(point, maxDistance = 28) {
    if (times.length === 0) return point;
    const index = Math.max(0, Math.min(times.length - 1, Math.round(timeToPosition(times, point.time))));
    const candle = candles[index];
    const best = [candle.open, candle.high, candle.low, candle.close].reduce((a, b) => (Math.abs(b - point.price) < Math.abs(a - point.price) ? b : a));
    const target = project({ time: candle.time, price: best });
    const current = project(point);
    if (Math.hypot(target.x - current.x, target.y - current.y) > maxDistance) return point;
    return { time: candle.time, price: best };
  }

  function mainPaneBounds() {
    return { width: chart.timeScale().width(), height: chart.panes()[0].getHeight() };
  }

  function destroy() {
    chart.remove();
  }

  return { chart, candleSeries, setData, refreshData, setIndicators, setAverageCost, project, unproject, snap, mainPaneBounds, destroy, getCandleCount: () => candles.length };
}
