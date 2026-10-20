import { isVisibleHolding, percentage } from '../../logic/calculations.js';
import { getAssetColor } from '../../logic/catalog.js';
import { formatNumber } from '../../logic/format.js';
import { upsertDonut } from '../charts.js';
import { setMetric } from '../metrics.js';
import { renderTable } from '../table.js';

function createColumns(totalCash) {
  return [
    {
      label: 'Account',
      render: (row) => row.asset,
      swatch: (row) => getAssetColor(row.asset),
      footer: () => 'Total',
    },
    { label: 'Broker', render: (row) => row.broker },
    {
      label: 'Balance (RM)',
      numeric: true,
      render: (row) => formatNumber(row.marketValue, 2),
      footer: (totals) => formatNumber(totals.marketValue, 2),
    },
    {
      label: 'Share (%)',
      numeric: true,
      render: (row) => formatNumber(percentage(row.marketValue, totalCash), 1),
      footer: () => (totalCash > 0 ? '100.0' : '0.0'),
    },
  ];
}

export function renderCashView({ holdings }) {
  const cash = holdings.filter((holding) => holding.category === 'Cash');
  const totalCash = cash.reduce((sum, holding) => sum + holding.marketValue, 0);

  setMetric('metric-cash-total', totalCash);

  upsertDonut(
    'chart-cash-split',
    cash.map((holding, index) => ({
      label: holding.asset,
      value: holding.marketValue,
      color: getAssetColor(holding.asset, index),
    })),
    { centerTitle: 'Total cash' },
  );

  renderTable('table-cash', {
    columns: createColumns(totalCash),
    rows: cash.filter(isVisibleHolding),
    totals: { marketValue: totalCash },
    emptyMessage: 'No cash recorded. Choose Add transaction and deposit cash.',
  });
}
