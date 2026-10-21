// Lookup helpers built on top of ASSET_CATALOG. No browser features are used here.

import {
  ASSET_CATALOG,
  BROKER_ORDER,
  CATEGORY_COLORS,
  ENTRY_CURRENCY_RULES,
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

// Returns 'USD', 'USDT' or null when prices for this broker and asset are typed in RM.
export function getEntryCurrency(broker, assetName) {
  const category = findAsset(assetName)?.category;
  const rule = ENTRY_CURRENCY_RULES.find((item) => item.broker === broker && item.category === category);
  return rule ? rule.currency : null;
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
