// Column lists shared by several tables.

import { getAssetColor } from '../logic/catalog.js';
import { formatNumber, formatPercent, formatQuantity, formatSignedAmount, getMoneyUnit } from '../logic/format.js';

// Columns for a table of holdings that have a market price (stocks and crypto).
export function createHoldingColumns({ showBroker = false, quantityLabel = 'Quantity' } = {}) {
  const columns = [
    {
      label: 'Asset',
      render: (row) => row.asset,
      swatch: (row) => getAssetColor(row.asset),
      footer: () => 'Total',
    },
  ];

  if (showBroker) {
    columns.push({ label: 'Broker', render: (row) => row.broker });
  }

  columns.push(
    { label: quantityLabel, numeric: true, render: (row) => formatQuantity(row.qty, 6) },
    { label: `Price (${getMoneyUnit()})`, numeric: true, render: (row) => formatNumber(row.unitPrice, 2) },
    {
      label: `Value (${getMoneyUnit()})`,
      numeric: true,
      render: (row) => formatNumber(row.marketValue, 2),
      footer: (totals) => formatNumber(totals.marketValue, 2),
    },
    {
      label: `Cost (${getMoneyUnit()})`,
      numeric: true,
      render: (row) => formatNumber(row.costMyr, 2),
      footer: (totals) => formatNumber(totals.costMyr, 2),
    },
    {
      label: `Unrealised P/L (${getMoneyUnit()})`,
      numeric: true,
      render: (row) => formatSignedAmount(row.unrealisedPl),
      tone: (row) => row.unrealisedPl,
      footer: (totals) => formatSignedAmount(totals.unrealisedPl),
    },
    {
      label: 'P/L (%)',
      numeric: true,
      render: (row) => formatPercent(row.unrealisedPlPct),
      tone: (row) => row.unrealisedPl,
      footer: (totals) => formatPercent(totals.unrealisedPlPct),
    },
    {
      label: `Realised P/L (${getMoneyUnit()})`,
      numeric: true,
      render: (row) => formatSignedAmount(row.realisedPl),
      tone: (row) => row.realisedPl,
      footer: (totals) => formatSignedAmount(totals.realisedPl),
    },
  );

  return columns;
}
