// The Chart tab: a candlestick chart with indicators and drawing tools, like TradingView.
//
// This tab differs from the others. The other tabs redraw their tables whenever the data changes.
// The chart must not be rebuilt each time, or it would lose the zoom and the lines being drawn.
// So initChartView() runs once at start-up, renderChartView() builds the chart the first time the tab opens
// and afterwards only refreshes the average cost line, and disposeChartView() removes the chart when the tab closes.

import { CHART_REFRESH_MS } from '../../config.js';
import { DRAWING_COLORS } from '../../logic/chart-drawings.js';
import { findAssetForChartItem, getChartItems } from '../../logic/catalog.js';
import { loadCandles, searchAssets } from '../../services/chart-data.js';
import {
  flushChartSaves,
  loadDrawings,
  loadSettings,
  loadWatchlist,
  saveDrawings,
  saveSettings,
  saveWatchlist,
} from '../../services/chart-store.js';
import { getDisplayCurrency, getState, getUsdRate } from '../../state.js';
import { byId, createElement } from '../dom.js';
import { createChartEngine } from '../chart/chart-engine.js';
import { createDrawingController } from '../chart/drawing-controller.js';
import { showToast } from '../toast.js';

const INTERVALS = Object.freeze(['1m', '5m', '15m', '1h', '4h', '1D', '1W']);
const DAILY_INTERVALS = Object.freeze(['1D', '1W']);
const SEARCH_DELAY_MS = 300;

const TOOL_HINTS = Object.freeze({
  trend: 'Trend line: drag from the start to the end, or click twice. Press Esc to cancel.',
  ray: 'Ray: drag or click twice. The line continues past the second point.',
  hline: 'Support or resistance: click the price level. Drag the line afterwards to adjust it.',
  rect: 'Zone: drag from one corner to the opposite corner, or click twice.',
  fib: 'Fibonacci retracement: drag from one swing to the other, or click twice.',
});
const DEFAULT_HINT = 'Drag to move the chart, scroll or pinch to zoom. Pick a tool on the left to draw. Select a line to move, recolour or delete it.';

const DEFAULT_INDICATORS = Object.freeze({
  volume: true,
  sma: { on: false, period: 50 },
  ema: { on: false, period: 20 },
  bollinger: { on: false, period: 20 },
  rsi: { on: true, period: 14 },
  macd: { on: false },
});

let elements = null;
let settings = null; // Survives closing the tab: item, interval, currency, indicators.
let ui = null; // The mounted chart, or null while the tab is closed.
let watchlist = [];
let watchlistReady = false;
let warned = false;

let searchTimer = 0;
let searchAbort = null;
let searchResults = [];
let searchIndex = -1;

// ---------- Settings ----------

function normaliseItem(item) {
  const symbol = typeof item?.symbol === 'string' ? item.symbol : '';
  const coin = typeof item?.coin === 'string' ? item.coin : '';
  if (!symbol && !coin) return null;
  return {
    id: symbol || `cg:${coin}`,
    symbol,
    coin,
    ticker: String(item.ticker || symbol || coin).slice(0, 20),
    name: String(item.name || symbol || coin).slice(0, 80),
    type: String(item.type || ''),
  };
}

function buildSettings() {
  const saved = loadSettings();
  const holdings = getChartItems();
  const indicators = { ...DEFAULT_INDICATORS, ...(saved.indicators ?? {}) };
  for (const key of ['sma', 'ema', 'bollinger', 'rsi']) {
    indicators[key] = { ...DEFAULT_INDICATORS[key], ...(saved.indicators?.[key] ?? {}) };
    indicators[key].period = Math.max(2, Math.min(400, Math.round(Number(indicators[key].period)) || DEFAULT_INDICATORS[key].period));
  }
  indicators.macd = { on: Boolean(saved.indicators?.macd?.on) };
  indicators.volume = saved.indicators?.volume ?? DEFAULT_INDICATORS.volume;

  return {
    item: normaliseItem(saved.item) ?? holdings.find((entry) => entry.asset === 'BTC') ?? holdings[0],
    interval: INTERVALS.includes(saved.interval) ? saved.interval : '1D',
    currency: saved.currency === 'USD' || saved.currency === 'MYR' ? saved.currency : getDisplayCurrency(),
    indicators,
  };
}

function persistSettings() {
  saveSettings({ item: settings.item, interval: settings.interval, currency: settings.currency, indicators: settings.indicators });
}

function warnOnce(message) {
  if (!message || warned) return;
  warned = true;
  showToast(message, 'warning');
}

// ---------- Items and watchlist ----------

function holdingItems() {
  return getChartItems();
}

function allItems() {
  return [...holdingItems(), ...watchlist];
}

function isHolding(item) {
  return holdingItems().some((entry) => entry.id === item.id);
}

function isWatched(item) {
  return watchlist.some((entry) => entry.id === item.id);
}

function renderChips() {
  const groups = [
    { title: 'Holdings', items: holdingItems(), removable: false },
    { title: 'Watchlist', items: watchlist, removable: true },
  ];
  const nodes = [];
  for (const group of groups) {
    if (group.items.length === 0) continue;
    nodes.push(createElement('span', { className: 'chart-chip-title', text: group.title }));
    for (const item of group.items) {
      const wrapper = createElement('span', { className: 'chart-chip' });
      const select = createElement('button', {
        className: 'chart-chip-button',
        text: item.ticker,
        attributes: { type: 'button', 'data-chip': item.id, 'aria-pressed': String(item.id === settings.item.id), title: item.name },
      });
      wrapper.append(select);
      if (group.removable) {
        wrapper.append(
          createElement('button', {
            className: 'chart-chip-remove',
            text: 'x',
            attributes: { type: 'button', 'data-chip-remove': item.id, 'aria-label': `Remove ${item.ticker} from the watchlist` },
          }),
        );
      }
      nodes.push(wrapper);
    }
  }
  elements.chips.replaceChildren(...nodes);

  const watchButton = elements.watchToggle;
  watchButton.hidden = isHolding(settings.item);
  watchButton.setAttribute('aria-pressed', String(isWatched(settings.item)));
  watchButton.title = isWatched(settings.item) ? 'Remove from watchlist' : 'Add to watchlist';
}

function toggleWatch() {
  const item = settings.item;
  if (isHolding(item)) return;
  watchlist = isWatched(item) ? watchlist.filter((entry) => entry.id !== item.id) : [...watchlist, item];
  saveWatchlist(watchlist, warnOnce);
  renderChips();
}

function removeFromWatchlist(id) {
  watchlist = watchlist.filter((entry) => entry.id !== id);
  saveWatchlist(watchlist, warnOnce);
  renderChips();
}

// ---------- Search ----------

function hideResults() {
  elements.results.hidden = true;
  elements.input.setAttribute('aria-expanded', 'false');
  searchResults = [];
  searchIndex = -1;
}

function showResultsMessage(message) {
  elements.results.replaceChildren(createElement('li', { className: 'chart-result-message', text: message }));
  elements.results.hidden = false;
  elements.input.setAttribute('aria-expanded', 'true');
}

function highlightResult(index) {
  searchIndex = index;
  [...elements.results.querySelectorAll('[role="option"]')].forEach((node, position) => {
    node.setAttribute('aria-selected', String(position === index));
    if (position === index) node.scrollIntoView({ block: 'nearest' });
  });
}

function renderResults(results) {
  searchResults = results.map((result) => ({ ...normaliseItem(result), exchange: result.exchange ?? '' })).filter((item) => item.id);
  if (searchResults.length === 0) {
    showResultsMessage('No matching assets found.');
    return;
  }
  const rows = searchResults.map((item, index) => {
    const row = createElement('li', { className: 'chart-result', attributes: { role: 'option', 'aria-selected': 'false', 'data-index': String(index) } });
    row.append(
      createElement('strong', { className: 'chart-result-ticker', text: item.ticker }),
      createElement('span', { className: 'chart-result-name', text: item.name }),
      createElement('span', { className: 'chart-result-meta', text: [item.type, item.exchange].filter(Boolean).join(' - ') }),
    );
    return row;
  });
  elements.results.replaceChildren(...rows);
  elements.results.hidden = false;
  elements.input.setAttribute('aria-expanded', 'true');
  highlightResult(-1);
}

async function runSearch(query) {
  searchAbort?.abort();
  searchAbort = new AbortController();
  showResultsMessage('Searching...');
  try {
    renderResults(await searchAssets(query, searchAbort.signal));
  } catch (error) {
    if (error?.name === 'AbortError') return;
    showResultsMessage(`Search is not available right now. ${error.message}`);
  }
}

function handleSearchInput() {
  clearTimeout(searchTimer);
  const query = elements.input.value.trim();
  if (!query) {
    searchAbort?.abort();
    hideResults();
    return;
  }
  searchTimer = setTimeout(() => runSearch(query), SEARCH_DELAY_MS);
}

function handleSearchKey(event) {
  if (event.key === 'Escape') {
    hideResults();
    return;
  }
  if (searchResults.length === 0) return;
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    highlightResult((searchIndex + 1) % searchResults.length);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    highlightResult((searchIndex - 1 + searchResults.length) % searchResults.length);
  } else if (event.key === 'Enter') {
    event.preventDefault();
    chooseItem(searchResults[Math.max(0, searchIndex)]);
  }
}

// ---------- Choosing an asset, timeframe and currency ----------

function chooseItem(item) {
  if (!item) return;
  const normalised = normaliseItem(item);
  hideResults();
  elements.input.value = '';
  if (!normalised) return;
  settings.item = normalised;
  persistSettings();
  renderChips();
  if (ui) {
    flushChartSaves();
    ui.controller.load([]);
    loadChartData();
    loadSavedDrawings();
    updateAverageCost();
  }
}

function changeInterval(interval) {
  if (!INTERVALS.includes(interval) || interval === settings.interval) return;
  settings.interval = interval;
  persistSettings();
  renderIntervalButtons();
  if (ui) loadChartData();
}

function setCurrency(currency) {
  if (currency === settings.currency) return;
  settings.currency = currency;
  persistSettings();
  renderCurrencyButtons();
  if (ui) {
    flushChartSaves();
    ui.controller.load([]);
    loadChartData();
    loadSavedDrawings();
  }
}

function renderIntervalButtons() {
  elements.intervals.querySelectorAll('[data-interval]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.interval === settings.interval));
  });
}

function renderCurrencyButtons() {
  elements.currency.querySelectorAll('[data-chart-currency]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.chartCurrency === settings.currency));
  });
}

// ---------- Loading the candles ----------

function showMessage(text, { retry = false } = {}) {
  elements.message.hidden = false;
  elements.messageText.textContent = text;
  elements.retry.hidden = !retry;
}

function hideMessage() {
  elements.message.hidden = true;
}

// keepView is true for the automatic refresh: the zoom stays and an error stays quiet.
async function loadChartData({ keepView = false } = {}) {
  const current = ui;
  if (!current) return;
  current.abort?.abort();
  current.abort = new AbortController();
  const token = (current.token = (current.token ?? 0) + 1);
  const { item, interval, currency } = settings;

  if (!keepView) showMessage(`Loading ${item.ticker} candles...`);

  try {
    const result = await loadCandles(item, interval, currency, current.abort.signal);
    if (ui !== current || token !== current.token) return;

    current.shownCurrency = result.currency;
    const label = `${item.name} - ${interval} - ${result.currency}`;
    const refreshed = keepView && current.engine.refreshData(result.candles);
    if (!refreshed) {
      current.engine.setData(result.candles, { label, intraday: !DAILY_INTERVALS.includes(interval), indicators: settings.indicators });
    }
    hideMessage();
    renderNote(result);
    updateAverageCost();
  } catch (error) {
    if (error?.name === 'AbortError' || ui !== current || token !== current.token) return;
    if (!keepView) showMessage(`Candles could not be loaded. ${error.message}`, { retry: true });
  }
}

function renderNote(result) {
  const source = result.source === 'coingecko' ? 'CoinGecko' : 'Yahoo Finance';
  const converted = result.nativeCurrency && result.nativeCurrency !== result.currency ? ` Converted from ${result.nativeCurrency} with the exchange rate of each candle.` : '';
  elements.dataNote.textContent = `Source: ${source}. Prices in ${result.currency}.${converted} ${result.note ?? ''}`.trim();
}

async function loadSavedDrawings() {
  const current = ui;
  if (!current) return;
  const { item, currency } = settings;
  const { drawings, warning } = await loadDrawings(item.id, currency);
  if (ui !== current || item.id !== settings.item.id || currency !== settings.currency) return;
  current.controller.load(drawings);
  warnOnce(warning);
}

// ---------- Average cost line ----------

function updateAverageCost() {
  if (!ui) return;
  const asset = findAssetForChartItem(settings.item);
  const rows = asset ? getState().positions.filter((position) => position.asset === asset && position.qty > 0) : [];
  const quantity = rows.reduce((total, row) => total + row.qty, 0);
  const costMyr = rows.reduce((total, row) => total + row.costMyr, 0);

  let price = null;
  if (quantity > 0 && costMyr > 0) {
    const averageMyr = costMyr / quantity;
    const shown = ui.shownCurrency ?? settings.currency;
    price = shown === 'USD' ? (getUsdRate() ? averageMyr / getUsdRate() : null) : averageMyr;
  }
  ui.engine.setAverageCost(price, 'Avg cost');
}

// ---------- Drawing tools ----------

function setToolButtons(tool) {
  elements.tools.querySelectorAll('[data-tool]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.tool === tool)));
  elements.hint.textContent = tool ? TOOL_HINTS[tool] : DEFAULT_HINT;
}

function renderSelection(drawing) {
  elements.deleteButton.disabled = !drawing;
  const active = drawing?.color ?? ui?.controller.getColor();
  elements.swatches.querySelectorAll('[data-color]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.color === active)));
}

function handleToolsClick(event) {
  const toolButton = event.target.closest('[data-tool]');
  const actionButton = event.target.closest('[data-chart-action]');
  const swatch = event.target.closest('[data-color]');
  if (!ui) return;

  if (toolButton) {
    const next = ui.controller.getTool() === toolButton.dataset.tool ? null : toolButton.dataset.tool;
    ui.controller.setTool(next);
    setToolButtons(next);
    return;
  }
  if (swatch) {
    ui.controller.setColor(swatch.dataset.color);
    renderSelection(ui.controller.hasSelection() ? { color: swatch.dataset.color } : null);
    return;
  }
  if (!actionButton) return;

  const action = actionButton.dataset.chartAction;
  if (action === 'delete') ui.controller.deleteSelected();
  else if (action === 'clear' && ui.controller.getDrawings().length > 0 && window.confirm(`Delete all drawings on ${settings.item.ticker} (${settings.currency})?`)) ui.controller.clearAll();
  else if (action === 'magnet') {
    const next = actionButton.getAttribute('aria-pressed') !== 'true';
    actionButton.setAttribute('aria-pressed', String(next));
    ui.controller.setMagnet(next);
  }
}

function handleDrawingsChange(drawings) {
  saveDrawings(settings.item.id, settings.currency, drawings, warnOnce);
}

// ---------- Indicators ----------

function readIndicatorInputs() {
  const indicators = { ...settings.indicators };
  elements.indicatorPanel.querySelectorAll('[data-indicator]').forEach((box) => {
    const name = box.dataset.indicator;
    if (name === 'volume') indicators.volume = box.checked;
    else indicators[name] = { ...indicators[name], on: box.checked };
  });
  elements.indicatorPanel.querySelectorAll('[data-period]').forEach((input) => {
    const name = input.dataset.period;
    const period = Math.max(2, Math.min(400, Math.round(Number(input.value)) || DEFAULT_INDICATORS[name].period));
    indicators[name] = { ...indicators[name], period };
    input.value = String(period);
  });
  return indicators;
}

function writeIndicatorInputs() {
  elements.indicatorPanel.querySelectorAll('[data-indicator]').forEach((box) => {
    const name = box.dataset.indicator;
    box.checked = name === 'volume' ? settings.indicators.volume : settings.indicators[name].on;
  });
  elements.indicatorPanel.querySelectorAll('[data-period]').forEach((input) => {
    input.value = String(settings.indicators[input.dataset.period].period);
  });
}

function handleIndicatorChange() {
  settings.indicators = readIndicatorInputs();
  persistSettings();
  if (ui) ui.engine.setIndicators(settings.indicators);
}

function toggleIndicatorPanel() {
  const open = elements.indicatorPanel.hidden;
  elements.indicatorPanel.hidden = !open;
  elements.indicatorToggle.setAttribute('aria-expanded', String(open));
}

// ---------- Full screen ----------

function setFullscreen(on) {
  elements.card.classList.toggle('is-fullscreen', on);
  document.body.classList.toggle('is-scroll-locked', on);
  elements.fullscreen.setAttribute('aria-pressed', String(on));
  elements.fullscreen.title = on ? 'Exit full screen' : 'Full screen';
}

function handleDocumentKey(event) {
  if (event.key === 'Escape' && elements.card.classList.contains('is-fullscreen') && !ui?.controller.getTool() && !ui?.controller.hasSelection()) setFullscreen(false);
}

// ---------- Start and stop ----------

// Runs once at start-up. Attaches the controls that exist in index.html.
export function initChartView() {
  elements = {
    card: byId('chart-card'),
    input: byId('chart-search-input'),
    results: byId('chart-search-results'),
    currency: byId('chart-currency'),
    watchToggle: byId('chart-watch-toggle'),
    indicatorToggle: byId('chart-indicators-toggle'),
    fullscreen: byId('chart-fullscreen'),
    chips: byId('chart-chips'),
    intervals: byId('chart-intervals'),
    indicatorPanel: byId('chart-indicators-panel'),
    tools: byId('chart-tools'),
    swatches: byId('chart-swatches'),
    deleteButton: byId('chart-delete'),
    hint: byId('chart-hint'),
    canvas: byId('chart-canvas'),
    legend: byId('chart-legend'),
    message: byId('chart-message'),
    messageText: byId('chart-message-text'),
    retry: byId('chart-retry'),
    dataNote: byId('chart-data-note'),
  };

  elements.intervals.replaceChildren(
    ...INTERVALS.map((interval) => createElement('button', { text: interval, attributes: { type: 'button', 'data-interval': interval, 'aria-pressed': 'false' } })),
  );
  elements.swatches.replaceChildren(
    ...DRAWING_COLORS.map((color) => {
      const button = createElement('button', { className: 'chart-swatch', attributes: { type: 'button', 'data-color': color, 'aria-pressed': 'false', 'aria-label': `Line colour ${color}` } });
      button.style.backgroundColor = color;
      return button;
    }),
  );

  elements.intervals.addEventListener('click', (event) => {
    const button = event.target.closest('[data-interval]');
    if (button) changeInterval(button.dataset.interval);
  });
  elements.currency.addEventListener('click', (event) => {
    const button = event.target.closest('[data-chart-currency]');
    if (button) setCurrency(button.dataset.chartCurrency);
  });
  elements.chips.addEventListener('click', (event) => {
    const remove = event.target.closest('[data-chip-remove]');
    if (remove) {
      removeFromWatchlist(remove.dataset.chipRemove);
      return;
    }
    const chip = event.target.closest('[data-chip]');
    if (chip) chooseItem(allItems().find((item) => item.id === chip.dataset.chip));
  });
  elements.results.addEventListener('pointerdown', (event) => {
    const row = event.target.closest('[data-index]');
    if (!row) return;
    event.preventDefault(); // Keeps the focus in the search box until the choice is made.
    chooseItem(searchResults[Number(row.dataset.index)]);
  });
  elements.input.addEventListener('input', handleSearchInput);
  elements.input.addEventListener('keydown', handleSearchKey);
  elements.input.addEventListener('blur', () => setTimeout(hideResults, 150));
  elements.watchToggle.addEventListener('click', toggleWatch);
  elements.indicatorToggle.addEventListener('click', toggleIndicatorPanel);
  elements.indicatorPanel.addEventListener('change', handleIndicatorChange);
  elements.tools.addEventListener('click', handleToolsClick);
  elements.fullscreen.addEventListener('click', () => setFullscreen(!elements.card.classList.contains('is-fullscreen')));
  elements.retry.addEventListener('click', () => loadChartData());
  document.addEventListener('keydown', handleDocumentKey);
}

function mount() {
  settings = settings ?? buildSettings();
  const engine = createChartEngine(elements.canvas, { legendElement: elements.legend });
  const controller = createDrawingController({
    container: elements.canvas,
    engine,
    onChange: handleDrawingsChange,
    onToolDone: () => setToolButtons(null),
    onSelectionChange: renderSelection,
  });

  ui = { engine, controller, token: 0, abort: null, shownCurrency: null, timer: 0 };
  ui.timer = setInterval(() => {
    if (!document.hidden) loadChartData({ keepView: true });
  }, CHART_REFRESH_MS);

  renderIntervalButtons();
  renderCurrencyButtons();
  writeIndicatorInputs();
  setToolButtons(null);
  renderSelection(null);
  renderChips();

  if (!watchlistReady) {
    watchlistReady = true;
    loadWatchlist().then(({ watchlist: saved, warning }) => {
      watchlist = saved;
      warnOnce(warning);
      if (elements) renderChips();
    });
  }
  loadChartData();
  loadSavedDrawings();
}

// Called on every state change. Builds the chart the first time, then only refreshes the average cost line.
export function renderChartView() {
  if (!elements) return;
  if (!ui) mount();
  else updateAverageCost();
}

export function disposeChartView() {
  if (!ui) return;
  clearInterval(ui.timer);
  ui.abort?.abort();
  searchAbort?.abort();
  clearTimeout(searchTimer);
  flushChartSaves();
  ui.controller.destroy();
  ui.engine.destroy();
  ui = null;
  hideResults();
  setFullscreen(false);
}
