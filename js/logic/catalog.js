// Lookup helpers built on top of ASSET_CATALOG. No browser features are used here.

import { ASSET_CATALOG, BROKER_ORDER, CATEGORY_COLORS, FALLBACK_COLORS } from '../config.js';

export function findAsset(assetName) {
  return ASSET_CATALOG.find((entry) => entry.asset === assetName) ?? null;
}

export function getCoinIds() {
  return [...new Set(ASSET_CATALOG.filter((entry) => entry.coinId).map((entry) => entry.coinId))];
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
