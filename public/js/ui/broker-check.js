// The "Broker check" card on the Summary tab. It lists where the quantities the brokers report
// differ from the quantities in the ledger. The brokers are read by the Worker, not by this page.

import { QUANTITY_DECIMALS } from '../config.js';
import { formatNumber } from '../logic/format.js';
import { MATCH_STATES, reconcileBalances } from '../logic/reconcile.js';
import { byId } from './dom.js';
import { renderTable } from './table.js';

const STATE_LABELS = Object.freeze({
  [MATCH_STATES.match]: 'Matches',
  [MATCH_STATES.differs]: 'Differs',
  [MATCH_STATES.missingInLedger]: 'Not in ledger',
  [MATCH_STATES.missingAtBroker]: 'Not at broker',
});

const COLUMNS = Object.freeze([
  { label: 'Broker', render: (row) => row.broker },
  { label: 'Asset', render: (row) => row.asset },
  { label: 'Ledger', numeric: true, render: (row) => formatNumber(row.ledgerQty, QUANTITY_DECIMALS) },
  { label: 'Broker says', numeric: true, render: (row) => formatNumber(row.brokerQty, QUANTITY_DECIMALS) },
  { label: 'Difference', numeric: true, render: (row) => formatNumber(row.difference, QUANTITY_DECIMALS), tone: (row) => (row.state === MATCH_STATES.match ? 0 : row.difference) },
  { label: 'Result', render: (row) => STATE_LABELS[row.state] },
]);

function describeStatuses(statuses) {
  if (statuses.length === 0) return 'Broker sync is not set up. See "Broker sync" in the README.';
  return statuses
    .map((status) => {
      const time = new Date(status.syncedAt).toLocaleString();
      const action = status.broker === 'Ledger' ? 'updated' : 'read';
      if (!status.ok) return `${status.broker}: failed at ${time} (${status.message})`;
      return status.message ? `${status.broker}: ${action} ${time} (${status.message})` : `${status.broker}: ${action} ${time}`;
    })
    .join('. ');
}

export function renderBrokerCheck({ positions, brokerSync }) {
  const { balances, statuses } = brokerSync;
  byId('broker-check-status').textContent = describeStatuses(statuses);

  // A broker whose last read failed is left out, so old numbers never look current.
  const syncedBrokers = statuses.filter((status) => status.ok).map((status) => status.broker);
  const rows = reconcileBalances({ brokerBalances: balances, positions, syncedBrokers });

  renderTable('table-broker-check', {
    columns: COLUMNS,
    rows,
    emptyMessage: syncedBrokers.length > 0 ? 'Nothing to compare.' : 'No broker has been read yet.',
  });
}
