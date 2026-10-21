// Pure calculation functions. They only take numbers in and give numbers out,
// so they are easy to test (see tests/calculations.test.js).

import { CATEGORY_ORDER, MONEY_DECIMALS, QUANTITY_DECIMALS, RATE_KEYS } from '../config.js';
import { findAsset, getPriceKey } from './catalog.js';

const QUANTITY_EPSILON = 1e-9;

export function roundTo(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

export function percentage(part, whole) {
  return whole > 0 ? (part / whole) * 100 : 0;
}

function isUsablePrice(value) {
  return Number.isFinite(value) && value > 0;
}

// Price order: fixed price, then market price, then average cost per unit.
export function resolveUnitPrice(position, marketPrices) {
  const entry = findAsset(position.asset);

  if (entry?.fixedPrice) {
    return { price: entry.fixedPrice, source: 'fixed' };
  }

  const priceKey = getPriceKey(position.asset);
  const marketPrice = priceKey ? marketPrices[priceKey] : undefined;
  if (isUsablePrice(marketPrice)) {
    return { price: marketPrice, source: 'market' };
  }

  if (position.qty > 0) {
    return { price: position.costMyr / position.qty, source: 'cost' };
  }

  return { price: 0, source: 'none' };
}

// RM per 1 unit of USD or USDT. USDT and USD are within a fraction of a percent of each other,
// so either one stands in for the other when only one rate is known.
export function findRate(marketPrices, currency) {
  const usable = (value) => (isUsablePrice(value) ? value : null);
  const direct = usable(marketPrices[RATE_KEYS[currency]]);
  if (direct) return direct;
  const other = currency === 'USD' ? 'USDT' : 'USD';
  return usable(marketPrices[RATE_KEYS[other]]);
}

export function buildHoldings(positions, marketPrices) {
  return positions.map((position) => {
    const { price, source } = resolveUnitPrice(position, marketPrices);
    const marketValue = position.qty * price;
    const unrealisedPl = marketValue - position.costMyr;

    return {
      ...position,
      unitPrice: price,
      priceSource: source,
      marketValue,
      unrealisedPl,
      unrealisedPlPct: percentage(unrealisedPl, position.costMyr),
    };
  });
}

export function summarise(holdings) {
  const totals = holdings.reduce(
    (sum, holding) => ({
      marketValue: sum.marketValue + holding.marketValue,
      costMyr: sum.costMyr + holding.costMyr,
      realisedPl: sum.realisedPl + holding.realisedPl,
    }),
    { marketValue: 0, costMyr: 0, realisedPl: 0 },
  );
  const unrealisedPl = totals.marketValue - totals.costMyr;

  return {
    ...totals,
    unrealisedPl,
    unrealisedPlPct: percentage(unrealisedPl, totals.costMyr),
  };
}

// Adds up holdings that share the same key, for example the same category.
export function groupTotals(holdings, getKey) {
  const groups = new Map();

  for (const holding of holdings) {
    const key = getKey(holding);
    const group = groups.get(key) ?? { key, marketValue: 0, costMyr: 0, realisedPl: 0 };
    group.marketValue += holding.marketValue;
    group.costMyr += holding.costMyr;
    group.realisedPl += holding.realisedPl;
    groups.set(key, group);
  }

  return [...groups.values()].map((group) => {
    const unrealisedPl = group.marketValue - group.costMyr;
    return { ...group, unrealisedPl, unrealisedPlPct: percentage(unrealisedPl, group.costMyr) };
  });
}

export function sortByCategoryOrder(groups) {
  const rank = (key) => {
    const index = CATEGORY_ORDER.indexOf(key);
    return index === -1 ? CATEGORY_ORDER.length : index;
  };
  return [...groups].sort((a, b) => rank(a.key) - rank(b.key));
}

export function isVisibleHolding(holding) {
  return holding.qty > QUANTITY_EPSILON || Math.abs(holding.realisedPl) >= 0.005;
}

export function listPriceFallbacks(holdings) {
  return holdings.filter((holding) => holding.priceSource === 'cost' && holding.qty > 0).map((holding) => holding.asset);
}

// Applies one buy or sell to a position using the weighted-average cost method.
//   buy  : quantity and cost both grow.
//   sell : cost leaves at the average cost per unit; the rest of the proceeds is realised profit or loss.
export function applyTransaction(position, { action, qty, unitPrice }) {
  if (!Number.isFinite(qty) || qty <= 0) {
    throw new Error('Enter a quantity greater than zero.');
  }
  if (!Number.isFinite(unitPrice) || unitPrice < 0) {
    throw new Error('Enter a price of zero or more.');
  }

  const totalAmount = qty * unitPrice;

  if (action === 'buy') {
    return {
      totalAmount,
      realisedChange: 0,
      updatedPosition: {
        ...position,
        qty: roundTo(position.qty + qty, QUANTITY_DECIMALS),
        costMyr: roundTo(position.costMyr + totalAmount, MONEY_DECIMALS),
      },
    };
  }

  if (action === 'sell') {
    if (qty > position.qty + QUANTITY_EPSILON) {
      throw new Error('You cannot sell more than you hold.');
    }

    const sellQty = Math.min(qty, position.qty);
    const averageCost = position.qty > 0 ? position.costMyr / position.qty : 0;
    const costRemoved = averageCost * sellQty;
    const remainingQty = roundTo(position.qty - sellQty, QUANTITY_DECIMALS);
    const isClosed = remainingQty <= QUANTITY_EPSILON;
    const realisedChange = sellQty * unitPrice - costRemoved;

    return {
      totalAmount,
      realisedChange,
      updatedPosition: {
        ...position,
        qty: isClosed ? 0 : remainingQty,
        costMyr: isClosed ? 0 : roundTo(position.costMyr - costRemoved, MONEY_DECIMALS),
        realisedPl: roundTo(position.realisedPl + realisedChange, MONEY_DECIMALS),
      },
    };
  }

  throw new Error('Choose buy or sell.');
}
