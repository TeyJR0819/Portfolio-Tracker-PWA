import { groupTotals, isVisibleHolding, summarise } from '../../logic/calculations.js';
import { getAssetColor } from '../../logic/catalog.js';
import { formatSignedRm } from '../../logic/format.js';
import { createHoldingColumns } from '../columns.js';
import { upsertDonut } from '../charts.js';
import { setMetric } from '../metrics.js';
import { renderTable } from '../table.js';

function toSlices(holdings) {
  return groupTotals(holdings, (holding) => holding.asset)
    .sort((a, b) => b.marketValue - a.marketValue)
    .map((group, index) => ({ label: group.key, value: group.marketValue, color: getAssetColor(group.key, index) }));
}

export function renderCryptoView({ holdings }) {
  const crypto = holdings.filter((holding) => holding.category === 'Crypto');
  const totals = summarise(crypto);

  setMetric('metric-crypto-value', totals.marketValue);
  setMetric('metric-crypto-unrealised', totals.unrealisedPl, { format: formatSignedRm, toned: true });
  setMetric('metric-crypto-realised', totals.realisedPl, { format: formatSignedRm, toned: true });

  upsertDonut('chart-crypto-luno', toSlices(crypto.filter((holding) => holding.broker === 'Luno')), {
    centerTitle: 'Luno',
  });
  upsertDonut('chart-crypto-pionex', toSlices(crypto.filter((holding) => holding.broker === 'Pionex')), {
    centerTitle: 'Pionex spot',
  });
  upsertDonut('chart-crypto-combined', toSlices(crypto), { centerTitle: 'Combined' });

  renderTable('table-crypto', {
    columns: createHoldingColumns({ showBroker: true }),
    rows: crypto.filter(isVisibleHolding).sort((a, b) => b.marketValue - a.marketValue),
    totals,
    emptyMessage: 'No crypto holdings yet. Choose Add transaction and buy your first coin.',
  });
}
