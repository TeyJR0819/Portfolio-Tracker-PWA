// Lookup helpers built on top of ASSET_CATALOG. No browser features are used here.

import {
  ASSET_CATALOG,
  BROKER_ORDER,
  BASE_CURRENCY,
  BROKER_CURRENCIES,
  CATEGORY_COLORS,
  FALLBACK_COLORS,
  USDT_COIN_ID,
} from '../config.js';

export function findAsset(assetName) {
  return ASSET_CATALOG.find((entry) => entry.asset === assetName) ?? null;
}

export function getCoinIds() {
  const assetIds = ASSET_CATALOG.filter((entry) => entry.coinId).map((entry) => entry.coinId);
  return [...new Set([...assetIds, USDT_COIN_ID])];
}

export function getStockSymbols() {
  return [...new Set(ASSET_CATALOG.filter((entry) => entry.stockSymbol).map((entry) => entry.stockSymbol))];
}

// The key under which a price is stored: a CoinGecko id or a stock symbol.
export function getPriceKey(assetName) {
  const entry = findAsset(assetName);
  return entry?.coinId ?? entry?.stockSymbol ?? null;
}

// 'MYR', 'USD' or 'USDT': the currency a broker account works in.
export function getBrokerCurrency(broker) {
  return BROKER_CURRENCIES[broker] ?? BASE_CURRENCY;
}

// Cash and money market accounts: the places money can sit and move between.
export function getAccounts() {
  return ASSET_CATALOG.filter((entry) => entry.category === 'Cash' || entry.category === 'MMF').map((entry) => ({
    asset: entry.asset,
    category: entry.category,
    broker: entry.brokers[0],
    currency: getBrokerCurrency(entry.brokers[0]),
  }));
}

export function findAccount(assetName) {
  return getAccounts().find((account) => account.asset === assetName) ?? null;
}

// The cash account of a broker, for example "IBKR Cash" for IBKR. Null when the broker has none.
export function getCashAssetForBroker(broker) {
  const entry = ASSET_CATALOG.find((item) => item.category === 'Cash' && item.brokers.includes(broker));
  return entry ? entry.asset : null;
}

// Assets that can be bought and sold (not cash or money market funds).
export function getTradableAssetsForBroker(broker) {
  return getAssetsForBroker(broker).filter((entry) => entry.category === 'Crypto' || entry.category === 'Stocks');
}

// Brokers that offer at least one tradable asset.
export function getTradingBrokers() {
  return getBrokers().filter((broker) => getTradableAssetsForBroker(broker).length > 0);
}

export function isFixedPriceAsset(assetName) {
  return Boolean(findAsset(assetName)?.fixedPrice);
}

export function getBrokers() {
  return BROKER_ORDER.filter((broker) => ASSET_CATALOG.some((entry) => entry.brokers.includes(broker)));
}

export function getAssetsForBroker(broker) {
  return ASSET_CATALOG.filter((entry) => entry.brokers.includes(broker));
}

export function getAssetColor(assetName, fallbackIndex = 0) {
  return findAsset(assetName)?.color ?? FALLBACK_COLORS[fallbackIndex % FALLBACK_COLORS.length];
}

export function getCategoryColor(categoryName, fallbackIndex = 0) {
  return CATEGORY_COLORS[categoryName] ?? FALLBACK_COLORS[fallbackIndex % FALLBACK_COLORS.length];
}

export function findPosition(positions, broker, assetName) {
  return positions.find((position) => position.broker === broker && position.asset === assetName) ?? null;
}

export function createEmptyPosition(broker, assetName) {
  const entry = findAsset(assetName);
  return {
    id: null,
    category: entry ? entry.category : 'Crypto',
    broker,
    asset: assetName,
    qty: 0,
    costMyr: 0,
    realisedPl: 0,
  };
}
