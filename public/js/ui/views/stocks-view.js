import { groupTotals, isVisibleHolding, summarise } from '../../logic/calculations.js';
import { getAssetColor } from '../../logic/catalog.js';
import { formatPercent, formatSignedMoney } from '../../logic/format.js';
import { createHoldingColumns } from '../columns.js';
import { upsertDonut } from '../charts.js';
import { setMetric } from '../metrics.js';
import { renderTable } from '../table.js';

function toSlices(holdings) {
  return groupTotals(holdings, (holding) => holding.asset)
    .sort((a, b) => b.marketValue - a.marketValue)
    .map((group, index) => ({ label: group.key, value: group.marketValue, color: getAssetColor(group.key, index) }));
}

export function renderStocksView({ holdings }) {
  const stocks = holdings.filter((holding) => holding.category === 'Stocks');
  const totals = summarise(stocks);

  setMetric('metric-stocks-value', totals.marketValue);
  setMetric('metric-stocks-cost', totals.costMyr);
  setMetric('metric-stocks-pl', totals.unrealisedPl, { format: formatSignedMoney, toned: true });
  setMetric('metric-stocks-pct', totals.unrealisedPlPct, { format: formatPercent, toned: true });

  upsertDonut('chart-stocks-moomoo', toSlices(stocks.filter((holding) => holding.broker === 'Moomoo')), { centerTitle: 'Moomoo' });
  upsertDonut('chart-stocks-webull', toSlices(stocks.filter((holding) => holding.broker === 'Webull')), { centerTitle: 'Webull' });
  upsertDonut('chart-stocks-ibkr', toSlices(stocks.filter((holding) => holding.broker === 'IBKR')), { centerTitle: 'IBKR' });
  upsertDonut('chart-stocks-combined', toSlices(stocks), { centerTitle: 'Combined' });

  renderTable('table-stocks', {
    columns: createHoldingColumns({ quantityLabel: 'Units', showBroker: true }),
    rows: stocks.filter(isVisibleHolding).sort((a, b) => b.marketValue - a.marketValue),
    totals,
    emptyMessage: 'No ETF holdings yet. Choose Add entry and buy VOO, QQQM, SPYL or SMH.',
  });
}
