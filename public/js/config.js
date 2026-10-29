// Central settings. Change values here instead of searching through the code.

export const STORAGE_KEYS = Object.freeze({
  credentials: 'portfolio.credentials',
  rememberDevice: 'portfolio.rememberDevice',
  sessionUnlocked: 'portfolio.sessionUnlocked',
  priceCache: 'portfolio.priceCache',
  positionsSnapshot: 'portfolio.positionsSnapshot',
  displayCurrency: 'portfolio.displayCurrency',
});

export const DATABASE_TABLE = 'portfolio';
export const TRANSACTIONS_TABLE = 'transactions';
export const TRANSACTIONS_LIMIT = 500;

export const PRICE_API_URL = 'https://api.coingecko.com/api/v3/simple/price';
export const PRICE_CURRENCY = 'myr';
// Stock quotes come from our own Cloudflare function (Yahoo Finance, with Finnhub as a backup).
export const STOCK_API_PATH = './api/stocks';
export const USDT_COIN_ID = 'tether'; // Gives the USDT to RM rate used for Pionex.
export const PRICE_CACHE_SECONDS = 120;
export const PRICE_REQUEST_TIMEOUT_MS = 8000;
export const PRICE_MANUAL_REFRESH_COOLDOWN_MS = 10000;
export const AUTO_REFRESH_MS = 120000;

export const PIN_MAX_ATTEMPTS = 5;
export const PIN_LOCKOUT_SECONDS = 30;

export const QUANTITY_DECIMALS = 8;
export const MONEY_DECIMALS = 2;

// Display order of categories and their chart colours.
export const CATEGORY_ORDER = Object.freeze(['Crypto', 'Cash', 'MMF', 'Stocks']);

export const CATEGORY_COLORS = Object.freeze({
  Crypto: '#6366F1',
  Cash: '#059669',
  MMF: '#D97706',
  Stocks: '#7C3AED',
});

// Colours for assets that are not listed in ASSET_CATALOG.
export const FALLBACK_COLORS = Object.freeze(['#94A3B8', '#F472B6', '#FACC15', '#38BDF8', '#A3E635']);

// One entry per asset the app knows about.
//   brokers    : where the asset can be held
//   coinId     : CoinGecko identifier (crypto)
//   stockSymbol: Yahoo Finance symbol (stocks and ETFs)
//   fixedPrice : price in RM that never changes (RM cash and money market funds)
//   priceCurrency: the balance is held in this currency (USD or USDT), so its price is the exchange rate
export const ASSET_CATALOG = Object.freeze([
  { asset: 'BTC', category: 'Crypto', brokers: ['Luno', 'Pionex'], coinId: 'bitcoin', color: '#F59E0B' },
  { asset: 'ETH', category: 'Crypto', brokers: ['Luno', 'Pionex'], coinId: 'ethereum', color: '#8B5CF6' },
  { asset: 'ADA', category: 'Crypto', brokers: ['Luno', 'Pionex'], coinId: 'cardano', color: '#10B981' },
  { asset: 'LINK', category: 'Crypto', brokers: ['Luno', 'Pionex'], coinId: 'chainlink', color: '#2563EB' },
  { asset: 'SUI', category: 'Crypto', brokers: ['Luno', 'Pionex'], coinId: 'sui', color: '#06B6D4' },
  { asset: 'TON', category: 'Crypto', brokers: ['Luno', 'Pionex'], coinId: 'the-open-network', color: '#EC4899' },
  { asset: 'Bank Cash', category: 'Cash', brokers: ['Bank'], fixedPrice: 1, color: '#059669' },
  { asset: 'Luno Cash', category: 'Cash', brokers: ['Luno'], fixedPrice: 1, color: '#14B8A6' },
  { asset: 'Pionex Cash', category: 'Cash', brokers: ['Pionex'], priceCurrency: 'USDT', color: '#0284C7' },
  { asset: 'Moomoo Cash', category: 'Cash', brokers: ['Moomoo'], fixedPrice: 1, color: '#EA580C' },
  { asset: 'IBKR Cash', category: 'Cash', brokers: ['IBKR'], priceCurrency: 'USD', color: '#DC2626' },
  { asset: 'Moomoo MMF', category: 'MMF', brokers: ['Moomoo'], fixedPrice: 1, color: '#D97706' },
  { asset: 'VOO', category: 'Stocks', brokers: ['Moomoo', 'IBKR'], stockSymbol: 'VOO', color: '#7C3AED' },
  { asset: 'QQQM', category: 'Stocks', brokers: ['Moomoo', 'IBKR'], stockSymbol: 'QQQM', color: '#A78BFA' },
  { asset: 'SPYL', category: 'Stocks', brokers: ['Moomoo', 'IBKR'], stockSymbol: 'SPYL.L', color: '#C4B5FD' },
]);

export const BROKER_ORDER = Object.freeze(['Luno', 'Pionex', 'Moomoo', 'IBKR', 'Bank']);

// The currency each broker account works in. Every other broker works in RM.
// Prices, fees and cash movements at these brokers are typed in this currency.
// The app converts them to RM when it saves, so the database always holds RM costs.
export const BROKER_CURRENCIES = Object.freeze({ IBKR: 'USD', Pionex: 'USDT' });
export const BASE_CURRENCY = 'MYR';

// Names under which exchange rates (RM per 1 unit of the currency) are kept with the prices.
export const RATE_KEYS = Object.freeze({ USD: 'fx:USD', USDT: 'fx:USDT' });
