// Cloudflare Worker handlers for the Chart tab.
//
//   GET /api/chart-search?q=bitcoin
//     -> { results: [{ symbol, coin, name, type, exchange }] }
//   GET /api/candles?symbol=BTC-USD&coin=bitcoin&interval=1h&currency=MYR
//     -> { candles: [{ time, open, high, low, close, volume }], currency, nativeCurrency, source, note }
//
// Browsers cannot call Yahoo Finance directly (CORS), so the Worker does it.
// Yahoo Finance gives candles for stocks, ETFs and most coins. CoinGecko finds coins by name and is the
// backup candle source for a coin that Yahoo does not carry. Prices are converted to the requested currency
// (USD or MYR) bar by bar with Yahoo's exchange rate history, so an old candle uses the rate of its own day.
//
// Optional secret: COINGECKO_API_KEY (a free "demo" key raises the CoinGecko rate limit).

const YAHOO_CHART_URL = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const YAHOO_SEARCH_URL = 'https://query2.finance.yahoo.com/v1/finance/search';
const COINGECKO_URL = 'https://api.coingecko.com/api/v3';
const REQUEST_TIMEOUT_MS = 8000;

const SYMBOL_PATTERN = /^[A-Z0-9.^=-]{1,24}$/;
const COIN_PATTERN = /^[a-z0-9-]{1,80}$/;
const CURRENCIES = Object.freeze(['USD', 'MYR']);
const SEARCH_TYPES = Object.freeze({ EQUITY: 'Stock', ETF: 'ETF', CRYPTOCURRENCY: 'Crypto', INDEX: 'Index' });

// seconds : the length of one candle
// yahoo   : the interval and range asked from Yahoo Finance (Yahoo has no 4-hour candle, so 60m is joined)
// bucket  : seconds per candle when candles must be joined
// cgDays  : how many days of CoinGecko candles to ask for (its candle size depends on this number)
// cache   : seconds the answer may be reused
export const INTERVALS = Object.freeze({
  '1m': { seconds: 60, yahoo: '1m', range: '5d', bucket: 0, cgDays: 1, cache: 20 },
  '5m': { seconds: 300, yahoo: '5m', range: '1mo', bucket: 0, cgDays: 1, cache: 30 },
  '15m': { seconds: 900, yahoo: '15m', range: '1mo', bucket: 0, cgDays: 1, cache: 30 },
  '1h': { seconds: 3600, yahoo: '60m', range: '3mo', bucket: 0, cgDays: 1, cache: 60 },
  '4h': { seconds: 14400, yahoo: '60m', range: '6mo', bucket: 4 * 3600, cgDays: 30, cache: 60 },
  '1D': { seconds: 86400, yahoo: '1d', range: '5y', bucket: 0, cgDays: 365, cache: 120 },
  '1W': { seconds: 604800, yahoo: '1wk', range: '10y', bucket: 0, cgDays: 365, cache: 300 },
});

async function fetchJson(fetchImpl, url, headers = {}) {
  const response = await fetchImpl(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PortfolioTracker/1.0)', Accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`status ${response.status}`);
  return response.json();
}

// ---------- Candle helpers (pure, tested) ----------

// Joins small candles into bigger ones. Candles must be sorted by time.
export function aggregateCandles(candles, bucketSeconds) {
  if (!bucketSeconds) return candles;
  const joined = [];
  for (const candle of candles) {
    const start = Math.floor(candle.time / bucketSeconds) * bucketSeconds;
    const last = joined[joined.length - 1];
    if (last && last.time === start) {
      last.high = Math.max(last.high, candle.high);
      last.low = Math.min(last.low, candle.low);
      last.close = candle.close;
      last.volume += candle.volume;
    } else {
      joined.push({ ...candle, time: start });
    }
  }
  return joined;
}

// Multiplies every candle by the exchange rate that applied at its time.
// rates: [{ time, close }] sorted by time. A candle uses the latest rate at or before it.
export function convertCandles(candles, rates) {
  if (rates.length === 0) return null;
  let index = 0;
  return candles.map((candle) => {
    while (index + 1 < rates.length && rates[index + 1].time <= candle.time) index += 1;
    const rate = rates[index].close;
    return {
      ...candle,
      open: candle.open * rate,
      high: candle.high * rate,
      low: candle.low * rate,
      close: candle.close * rate,
    };
  });
}

// Yahoo quotes London-listed funds in pence (GBp). Convert to pounds.
function normaliseCurrency(candles, currency) {
  if (currency !== 'GBp' && currency !== 'GBX') return { candles, currency };
  return {
    currency: 'GBP',
    candles: candles.map((c) => ({ ...c, open: c.open / 100, high: c.high / 100, low: c.low / 100, close: c.close / 100 })),
  };
}

// ---------- Yahoo Finance ----------

export function parseYahooCandles(body) {
  const result = body?.chart?.result?.[0];
  const quote = result?.indicators?.quote?.[0];
  const times = result?.timestamp;
  if (!result || !quote || !Array.isArray(times)) throw new Error('no candles in the answer');

  const candles = [];
  for (let i = 0; i < times.length; i += 1) {
    const open = quote.open?.[i];
    const high = quote.high?.[i];
    const low = quote.low?.[i];
    const close = quote.close?.[i];
    if (![open, high, low, close].every((value) => Number.isFinite(value) && value > 0)) continue; // Yahoo leaves gaps as null.
    candles.push({ time: times[i], open, high, low, close, volume: Number.isFinite(quote.volume?.[i]) ? quote.volume[i] : 0 });
  }
  if (candles.length === 0) throw new Error('no candles in the answer');

  return { ...normaliseCurrency(candles, result.meta?.currency ?? 'USD'), name: result.meta?.longName || result.meta?.shortName || '' };
}

async function fetchYahooCandles(fetchImpl, symbol, interval) {
  const settings = INTERVALS[interval];
  const path = encodeURIComponent(symbol).replace(/%3D/g, '=').replace(/%5E/g, '^');
  const body = await fetchJson(fetchImpl, `${YAHOO_CHART_URL}${path}?interval=${settings.yahoo}&range=${settings.range}&includePrePost=false`);
  return parseYahooCandles(body);
}

async function fetchYahooRates(fetchImpl, from, to, interval) {
  const { candles } = await fetchYahooCandles(fetchImpl, `${from}${to}=X`, interval);
  return candles;
}

// ---------- CoinGecko ----------

function coinGeckoHeaders(env) {
  return env?.COINGECKO_API_KEY ? { 'x-cg-demo-api-key': env.COINGECKO_API_KEY } : {};
}

// CoinGecko candles come in a size it chooses: 30 minutes for 1 day, 4 hours for 2 to 30 days, 4 days beyond that.
async function fetchCoinGeckoCandles(fetchImpl, coin, interval, currency, env) {
  const settings = INTERVALS[interval];
  const url = `${COINGECKO_URL}/coins/${coin}/ohlc?vs_currency=${currency.toLowerCase()}&days=${settings.cgDays}`;
  const rows = await fetchJson(fetchImpl, url, coinGeckoHeaders(env));
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('no candles in the answer');

  const raw = rows
    .filter((row) => row.slice(1, 5).every((value) => Number.isFinite(value) && value > 0))
    .map(([ms, open, high, low, close]) => ({ time: Math.floor(ms / 1000), open, high, low, close, volume: 0 }));
  if (raw.length === 0) throw new Error('no candles in the answer');

  const size = raw.length > 1 ? raw[1].time - raw[0].time : 0;
  // Candles smaller than asked are joined. Candles bigger than asked cannot be split, so the person is told.
  const candles = settings.seconds > size ? aggregateCandles(raw, settings.seconds) : raw;
  const note = size > settings.seconds ? `CoinGecko offers ${describeSeconds(size)} candles at best for this coin and timeframe.` : '';
  return { candles, currency: currency.toUpperCase(), note };
}

function describeSeconds(seconds) {
  if (seconds >= 86400) return `${Math.round(seconds / 86400)}-day`;
  if (seconds >= 3600) return `${Math.round(seconds / 3600)}-hour`;
  return `${Math.round(seconds / 60)}-minute`;
}

// ---------- Candles ----------

// Exposed for the tests. fetchImpl is replaced by a fake there.
export async function getCandles({ symbol = '', coin = '', interval = '1D', currency = 'USD' }, { fetchImpl = fetch, env = {} } = {}) {
  const settings = INTERVALS[interval];
  if (!settings) throw new Error('Unknown interval.');
  const failures = [];

  if (symbol) {
    try {
      const yahoo = await fetchYahooCandles(fetchImpl, symbol, interval);
      let { candles } = yahoo;
      let shownCurrency = yahoo.currency;
      let note = '';

      if (shownCurrency !== currency) {
        try {
          // 4-hour candles are built from hourly ones, so the rates are hourly too.
          const rates = await fetchYahooRates(fetchImpl, shownCurrency, currency, interval === '4h' ? '1h' : interval);
          const converted = convertCandles(candles, rates);
          if (!converted) throw new Error('no rates');
          candles = converted;
          shownCurrency = currency;
        } catch {
          note = `The ${currency} exchange rate was not available, so prices are shown in ${shownCurrency}.`;
        }
      }
      return {
        candles: aggregateCandles(candles, settings.bucket),
        currency: shownCurrency,
        nativeCurrency: yahoo.currency,
        source: 'yahoo',
        name: yahoo.name,
        note,
      };
    } catch (error) {
      failures.push(`Yahoo Finance: ${error.message}`);
      if (!coin) throw new Error(failures.join('; '));
    }
  }

  if (coin) {
    try {
      const gecko = await fetchCoinGeckoCandles(fetchImpl, coin, interval, currency, env);
      return { candles: gecko.candles, currency: gecko.currency, nativeCurrency: gecko.currency, source: 'coingecko', name: '', note: gecko.note };
    } catch (error) {
      failures.push(`CoinGecko: ${error.message}`);
    }
  }

  throw new Error(failures.join('; ') || 'Provide a symbol or a coin.');
}

// ---------- Search ----------

export async function searchAssets(query, { fetchImpl = fetch, env = {} } = {}) {
  const [yahooOutcome, geckoOutcome] = await Promise.allSettled([
    fetchJson(fetchImpl, `${YAHOO_SEARCH_URL}?q=${encodeURIComponent(query)}&quotesCount=10&newsCount=0&listsCount=0`),
    fetchJson(fetchImpl, `${COINGECKO_URL}/search?query=${encodeURIComponent(query)}`, coinGeckoHeaders(env)),
  ]);

  const results = [];
  if (yahooOutcome.status === 'fulfilled') {
    for (const quote of yahooOutcome.value?.quotes ?? []) {
      const type = SEARCH_TYPES[quote.quoteType];
      if (!type || !SYMBOL_PATTERN.test(String(quote.symbol ?? ''))) continue;
      results.push({
        symbol: quote.symbol,
        coin: '',
        ticker: quote.symbol,
        name: quote.longname || quote.shortname || quote.symbol,
        type,
        exchange: quote.exchDisp || quote.exchange || '',
      });
    }
  }

  if (geckoOutcome.status === 'fulfilled') {
    const coins = [...(geckoOutcome.value?.coins ?? [])]
      .filter((coin) => COIN_PATTERN.test(String(coin.id ?? '')))
      .sort((a, b) => (a.market_cap_rank ?? 1e9) - (b.market_cap_rank ?? 1e9))
      .slice(0, 5);

    for (const coin of coins) {
      // Yahoo names a coin like "Sui USD". When both lists hold the same coin, keep Yahoo's entry and remember the CoinGecko id as a backup.
      const twin = results.find((item) => item.type === 'Crypto' && !item.coin && item.name.toLowerCase().startsWith(`${String(coin.name).toLowerCase()} `));
      if (twin) twin.coin = coin.id;
      else results.push({ symbol: '', coin: coin.id, ticker: String(coin.symbol ?? '').toUpperCase(), name: coin.name, type: 'Crypto', exchange: 'CoinGecko' });
    }
  }

  if (results.length === 0 && yahooOutcome.status === 'rejected' && geckoOutcome.status === 'rejected') {
    throw new Error('Both search services are unreachable.');
  }
  return results.slice(0, 12);
}

// ---------- HTTP handlers ----------

export async function handleCandlesRequest({ request, env }) {
  const params = new URL(request.url).searchParams;
  const symbol = (params.get('symbol') ?? '').trim().toUpperCase();
  const coin = (params.get('coin') ?? '').trim().toLowerCase();
  const interval = params.get('interval') ?? '1D';
  const currency = (params.get('currency') ?? 'USD').toUpperCase();

  const validSymbol = !symbol || SYMBOL_PATTERN.test(symbol);
  const validCoin = !coin || COIN_PATTERN.test(coin);
  if (!validSymbol || !validCoin || (!symbol && !coin) || !INTERVALS[interval] || !CURRENCIES.includes(currency)) {
    return Response.json({ error: 'Provide a valid symbol or coin, an interval and a currency (USD or MYR).' }, { status: 400 });
  }

  try {
    const result = await getCandles({ symbol, coin, interval, currency }, { env });
    return Response.json(result, { headers: { 'Cache-Control': `public, max-age=${INTERVALS[interval].cache}` } });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
  }
}

export async function handleChartSearchRequest({ request, env }) {
  const query = (new URL(request.url).searchParams.get('q') ?? '').trim();
  if (query.length < 1 || query.length > 40) {
    return Response.json({ error: 'Provide a search text of 1 to 40 characters.' }, { status: 400 });
  }
  try {
    const results = await searchAssets(query, { env });
    return Response.json({ results }, { headers: { 'Cache-Control': 'public, max-age=300' } });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
  }
}
