// Central settings. Change values here instead of searching through the code.

export const STORAGE_KEYS = Object.freeze({
  credentials: 'portfolio.credentials',
  rememberDevice: 'portfolio.rememberDevice',
  sessionUnlocked: 'portfolio.sessionUnlocked',
  priceCache: 'portfolio.priceCache',
  positionsSnapshot: 'portfolio.positionsSnapshot',
});

export const DATABASE_TABLE = 'portfolio';

export const PRICE_API_URL = 'https://api.coingecko.com/api/v3/simple/price';
export const PRICE_CURRENCY = 'myr';
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
//   coinId     : identifier used by the price service (omit for fixed-price assets)
//   fixedPrice : price in RM that never changes (cash and money market funds)
export const ASSET_CATALOG = Object.freeze([
  { asset: 'BTC', category: 'Crypto', brokers: ['Luno', 'Pionex'], coinId: 'bitcoin', color: '#F59E0B' },
  { asset: 'ETH', category: 'Crypto', brokers: ['Luno', 'Pionex'], coinId: 'ethereum', color: '#8B5CF6' },
  { asset: 'ADA', category: 'Crypto', brokers: ['Luno', 'Pionex'], coinId: 'cardano', color: '#10B981' },
  { asset: 'LINK', category: 'Crypto', brokers: ['Luno', 'Pionex'], coinId: 'chainlink', color: '#2563EB' },
  { asset: 'SUI', category: 'Crypto', brokers: ['Luno', 'Pionex'], coinId: 'sui', color: '#06B6D4' },
  { asset: 'TON', category: 'Crypto', brokers: ['Luno', 'Pionex'], coinId: 'the-open-network', color: '#EC4899' },
  { asset: 'Bank Cash', category: 'Cash', brokers: ['Bank'], fixedPrice: 1, color: '#059669' },
  { asset: 'Luno Cash', category: 'Cash', brokers: ['Luno'], fixedPrice: 1, color: '#14B8A6' },
  { asset: 'Moomoo MMF', category: 'MMF', brokers: ['Moomoo'], fixedPrice: 1, color: '#D97706' },
  { asset: 'VOO', category: 'Stocks', brokers: ['Moomoo'], coinId: 'vanguard-s-p-500-etf', color: '#7C3AED' },
  { asset: 'QQQM', category: 'Stocks', brokers: ['Moomoo'], coinId: 'invesco-qqq-trust', color: '#A78BFA' },
]);

export const BROKER_ORDER = Object.freeze(['Luno', 'Pionex', 'Moomoo', 'Bank']);
