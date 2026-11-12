import { groupTotals, isVisibleHolding, summarise } from '../../logic/calculations.js';
import { getAssetColor } from '../../logic/catalog.js';
import { formatPercent, formatSignedMoney } from '../../logic/format.js';
import { byId } from '../dom.js';
import { createHoldingColumns } from '../columns.js';
import { upsertDonut } from '../charts.js';
import { setMetric } from '../metrics.js';
import { renderTable } from '../table.js';

function toSlices(holdings) {
  return groupTotals(holdings, (holding) => holding.asset)
    .sort((a, b) => b.marketValue - a.marketValue)
    .map((group, index) => ({ label: group.key, value: group.marketValue, color: getAssetColor(group.key, index) }));
}

function renderBrokerDonut(broker, stocks) {
  const key = broker.toLowerCase();
  const slices = toSlices(stocks.filter((holding) => holding.broker === broker));
  upsertDonut(`chart-stocks-${key}`, slices, { centerTitle: broker });
  byId(`card-stocks-${key}`).hidden = !slices.some((slice) => slice.value > 0);
}

export function renderStocksView({ holdings }) {
  const stocks = holdings.filter((holding) => holding.category === 'Stocks');
  const totals = summarise(stocks);

  setMetric('metric-stocks-value', totals.marketValue);
  setMetric('metric-stocks-cost', totals.costMyr);
  setMetric('metric-stocks-pl', totals.unrealisedPl, { format: formatSignedMoney, toned: true });
  setMetric('metric-stocks-pct', totals.unrealisedPlPct, { format: formatPercent, toned: true });

  // Moomoo and Webull only get a chart while they hold something. IBKR and Combined always show.
  renderBrokerDonut('Moomoo', stocks);
  renderBrokerDonut('Webull', stocks);
  upsertDonut('chart-stocks-ibkr', toSlices(stocks.filter((holding) => holding.broker === 'IBKR')), { centerTitle: 'IBKR' });
  upsertDonut('chart-stocks-combined', toSlices(stocks), { centerTitle: 'Combined' });

  renderTable('table-stocks', {
    columns: createHoldingColumns({ quantityLabel: 'Units', showBroker: true }),
    rows: stocks.filter(isVisibleHolding).sort((a, b) => b.marketValue - a.marketValue),
    totals,
    emptyMessage: 'No ETF holdings yet. Choose Add entry and buy VOO, QQQM, SMH or SSO.',
  });
}
