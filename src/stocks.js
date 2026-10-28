// Cloudflare Worker handler: GET /api/stocks?symbols=VOO,QQQM,SPYL.L
//
// Browsers cannot call Yahoo Finance directly (CORS), and a Finnhub key must stay secret.
// This function runs on Cloudflare, fetches the quotes and answers with:
//   { quotes: { VOO: { price, currency, source } }, fx: { USD: 4.2 }, errors: { SYM: 'reason' } }
// Prices stay in each stock's own currency. The app converts them to RM.
//
// Optional secret: FINNHUB_API_KEY. It is used for US stocks when Yahoo Finance fails.

const YAHOO_CHART_URL = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const FINNHUB_QUOTE_URL = 'https://finnhub.io/api/v1/quote';
const SYMBOL_PATTERN = /^[A-Z0-9.=-]{1,15}$/;
const MAX_SYMBOLS = 10;
const REQUEST_TIMEOUT_MS = 6000;
const EDGE_CACHE_SECONDS = 60;

async function fetchJson(fetchImpl, url) {
  const response = await fetchImpl(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PortfolioTracker/1.0)', Accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`status ${response.status}`);
  return response.json();
}

// Yahoo quotes London-listed funds in pence (GBp). Convert to pounds so the currency is a real one.
function normaliseCurrency({ price, currency }) {
  return currency === 'GBp' || currency === 'GBX' ? { price: price / 100, currency: 'GBP' } : { price, currency };
}

async function fetchYahooQuote(fetchImpl, symbol) {
  // Symbols such as USDMYR=X keep their "=" sign, as Yahoo writes it in its own addresses.
  const path = encodeURIComponent(symbol).replace(/%3D/g, '=');
  const body = await fetchJson(fetchImpl, `${YAHOO_CHART_URL}${path}?interval=1d&range=1d`);
  const meta = body?.chart?.result?.[0]?.meta;
  if (!meta || !Number.isFinite(meta.regularMarketPrice) || meta.regularMarketPrice <= 0 || !meta.currency) {
    throw new Error('no price in the answer');
  }
  return { ...normaliseCurrency({ price: meta.regularMarketPrice, currency: meta.currency }), source: 'yahoo' };
}

async function fetchFinnhubQuote(fetchImpl, symbol, token) {
  const url = `${FINNHUB_QUOTE_URL}?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(token)}`;
  const body = await fetchJson(fetchImpl, url);
  if (!Number.isFinite(body?.c) || body.c <= 0) throw new Error('no price in the answer');
  return { price: body.c, currency: 'USD', source: 'finnhub' }; // Finnhub's free plan covers US stocks.
}

async function fetchQuote(fetchImpl, symbol, finnhubToken) {
  try {
    return await fetchYahooQuote(fetchImpl, symbol);
  } catch (yahooError) {
    if (!finnhubToken || symbol.includes('.')) throw new Error(`Yahoo Finance: ${yahooError.message}`);
    try {
      return await fetchFinnhubQuote(fetchImpl, symbol, finnhubToken);
    } catch (finnhubError) {
      throw new Error(`Yahoo Finance: ${yahooError.message}; Finnhub: ${finnhubError.message}`);
    }
  }
}

// Exposed for the tests. fetchImpl is replaced by a fake there.
export async function getStockQuotes(symbols, { fetchImpl = fetch, finnhubToken = '' } = {}) {
  const quotes = {};
  const errors = {};

  await Promise.all(
    symbols.map(async (symbol) => {
      try {
        quotes[symbol] = await fetchQuote(fetchImpl, symbol, finnhubToken);
      } catch (error) {
        errors[symbol] = error.message;
      }
    }),
  );

  // Exchange rates to RM for every currency that appears, plus USD (needed for IBKR entries).
  const currencies = new Set(['USD', ...Object.values(quotes).map((quote) => quote.currency)]);
  currencies.delete('MYR');
  const fx = {};

  await Promise.all(
    [...currencies].map(async (currency) => {
      try {
        fx[currency] = (await fetchYahooQuote(fetchImpl, `${currency}MYR=X`)).price;
      } catch (error) {
        errors[`${currency}MYR`] = error.message;
      }
    }),
  );

  return { quotes, fx, errors };
}

export async function handleStocksRequest({ request, env }) {
  const requested = new URL(request.url).searchParams.get('symbols') ?? '';
  const symbols = [...new Set(requested.split(',').map((item) => item.trim().toUpperCase()))].filter(Boolean);

  if (symbols.length === 0 || symbols.length > MAX_SYMBOLS || !symbols.every((item) => SYMBOL_PATTERN.test(item))) {
    return Response.json({ error: 'Provide 1 to 10 valid symbols.' }, { status: 400 });
  }

  const result = await getStockQuotes(symbols, { finnhubToken: env?.FINNHUB_API_KEY ?? '' });
  const hasQuotes = Object.keys(result.quotes).length > 0;

  return Response.json(result, {
    status: hasQuotes ? 200 : 502,
    headers: { 'Cache-Control': hasQuotes ? `public, max-age=${EDGE_CACHE_SECONDS}` : 'no-store' },
  });
}
