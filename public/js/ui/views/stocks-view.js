import { isVisibleHolding, summarise } from '../../logic/calculations.js';
import { formatPercent, formatSignedMoney } from '../../logic/format.js';
import { createHoldingColumns } from '../columns.js';
import { setMetric } from '../metrics.js';
import { renderTable } from '../table.js';

export function renderStocksView({ holdings }) {
  const stocks = holdings.filter((holding) => holding.category === 'Stocks');
  const totals = summarise(stocks);

  setMetric('metric-stocks-value', totals.marketValue);
  setMetric('metric-stocks-cost', totals.costMyr);
  setMetric('metric-stocks-pl', totals.unrealisedPl, { format: formatSignedMoney, toned: true });
  setMetric('metric-stocks-pct', totals.unrealisedPlPct, { format: formatPercent, toned: true });

  renderTable('table-stocks', {
    columns: createHoldingColumns({ quantityLabel: 'Units', showBroker: true }),
    rows: stocks.filter(isVisibleHolding).sort((a, b) => b.marketValue - a.marketValue),
    totals,
    emptyMessage: 'No ETF holdings yet. Choose Add entry and buy VOO, QQQM or SPYL.',
  });
}
