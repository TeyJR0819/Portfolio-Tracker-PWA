import { isVisibleHolding, percentage, summarise } from '../../logic/calculations.js';
import { getAssetColor } from '../../logic/catalog.js';
import { formatNumber, formatPercent, formatSignedAmount, formatSignedMoney, getMoneyUnit } from '../../logic/format.js';
import { setMetric } from '../metrics.js';
import { renderTable } from '../table.js';

function createColumns(portfolioValue) {
  return [
    {
      label: 'Fund',
      render: (row) => row.asset,
      swatch: (row) => getAssetColor(row.asset),
      footer: () => 'Total',
    },
    {
      label: `Balance (${getMoneyUnit()})`,
      numeric: true,
      render: (row) => formatNumber(row.marketValue, 2),
      footer: (totals) => formatNumber(totals.marketValue, 2),
    },
    {
      label: `Principal (${getMoneyUnit()})`,
      numeric: true,
      render: (row) => formatNumber(row.costMyr, 2),
      footer: (totals) => formatNumber(totals.costMyr, 2),
    },
    {
      label: `Gain (${getMoneyUnit()})`,
      numeric: true,
      render: (row) => formatSignedAmount(row.unrealisedPl),
      tone: (row) => row.unrealisedPl,
      footer: (totals) => formatSignedAmount(totals.unrealisedPl),
    },
    {
      label: 'Gain (%)',
      numeric: true,
      render: (row) => formatPercent(row.unrealisedPlPct),
      tone: (row) => row.unrealisedPl,
      footer: (totals) => formatPercent(totals.unrealisedPlPct),
    },
    {
      label: 'Share of portfolio (%)',
      numeric: true,
      render: (row) => formatNumber(percentage(row.marketValue, portfolioValue), 1),
      footer: (totals) => formatNumber(percentage(totals.marketValue, portfolioValue), 1),
    },
  ];
}

export function renderMmfView({ holdings, summary }) {
  const funds = holdings.filter((holding) => holding.category === 'MMF');
  const totals = summarise(funds);

  setMetric('metric-mmf-balance', totals.marketValue);
  setMetric('metric-mmf-principal', totals.costMyr);
  setMetric('metric-mmf-gain', totals.unrealisedPl, { format: formatSignedMoney, toned: true });
  setMetric('metric-mmf-pct', totals.unrealisedPlPct, { format: formatPercent, toned: true });

  renderTable('table-mmf', {
    columns: createColumns(summary.marketValue),
    rows: funds.filter(isVisibleHolding),
    totals,
    emptyMessage: 'No money market fund recorded. Choose Add entry and deposit to Moomoo MMF.',
  });
}
