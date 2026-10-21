import { groupTotals, percentage, sortByCategoryOrder } from '../../logic/calculations.js';
import { getCategoryColor } from '../../logic/catalog.js';
import { formatNumber, formatPercent, formatSignedRm } from '../../logic/format.js';
import { upsertDonut } from '../charts.js';
import { setMetric } from '../metrics.js';
import { renderTable } from '../table.js';

function createColumns(totalValue) {
  return [
    {
      label: 'Category',
      render: (row) => row.key,
      swatch: (row) => getCategoryColor(row.key),
      footer: () => 'Total',
    },
    {
      label: 'Value (RM)',
      numeric: true,
      render: (row) => formatNumber(row.marketValue, 2),
      footer: (totals) => formatNumber(totals.marketValue, 2),
    },
    {
      label: 'Cost (RM)',
      numeric: true,
      render: (row) => formatNumber(row.costMyr, 2),
      footer: (totals) => formatNumber(totals.costMyr, 2),
    },
    {
      label: 'Unrealised P/L (RM)',
      numeric: true,
      render: (row) => formatSignedRm(row.unrealisedPl).replace('RM ', ''),
      tone: (row) => row.unrealisedPl,
      footer: (totals) => formatSignedRm(totals.unrealisedPl).replace('RM ', ''),
    },
    {
      label: 'Realised P/L (RM)',
      numeric: true,
      render: (row) => formatSignedRm(row.realisedPl).replace('RM ', ''),
      tone: (row) => row.realisedPl,
      footer: (totals) => formatSignedRm(totals.realisedPl).replace('RM ', ''),
    },
    {
      label: 'Share (%)',
      numeric: true,
      render: (row) => formatNumber(percentage(row.marketValue, totalValue), 1),
      footer: () => (totalValue > 0 ? '100.0' : '0.0'),
    },
  ];
}

export function renderSummaryView({ holdings, summary }) {
  setMetric('metric-total-value', summary.marketValue);
  setMetric('metric-cost-basis', summary.costMyr);
  setMetric('metric-unrealised-pl', summary.unrealisedPl, { format: formatSignedRm, toned: true });
  setMetric('metric-unrealised-pct', summary.unrealisedPlPct, { format: formatPercent, toned: true });
  setMetric('metric-realised-pl', summary.realisedPl, { format: formatSignedRm, toned: true });

  const categories = sortByCategoryOrder(groupTotals(holdings, (holding) => holding.category));

  upsertDonut(
    'chart-summary-allocation',
    categories.map((group, index) => ({
      label: group.key,
      value: group.marketValue,
      color: getCategoryColor(group.key, index),
    })),
    { centerTitle: 'Total value' },
  );

  renderTable('table-summary', {
    columns: createColumns(summary.marketValue),
    rows: categories.filter((group) => group.marketValue > 0 || group.costMyr > 0 || group.realisedPl !== 0),
    totals: summary,
    emptyMessage: 'No holdings yet. Choose Add transaction to record your first one.',
  });
}
