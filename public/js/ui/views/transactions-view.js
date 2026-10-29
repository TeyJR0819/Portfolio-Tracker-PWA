// The Transactions page: every entry made in the app, newest first, with a type filter.
// Amounts are shown in the currency they were entered in. Values and profits are in RM,
// as they were on the day of the entry.

import { ENTRY_KINDS } from '../../logic/ledger.js';
import { findAccount } from '../../logic/catalog.js';
import { formatForeign, formatNumber, formatQuantity, formatSignedAmount } from '../../logic/format.js';
import { byId, createElement } from '../dom.js';
import { renderTable } from '../table.js';

const TYPE_NAMES = Object.freeze({
  buy: 'Buy',
  sell: 'Sell',
  transfer: 'Transfer',
  deposit: 'Deposit',
  cashout: 'Cash out',
  mmf_gain: 'MMF gain',
  adjust: 'Adjustment',
});

const ALL_TYPES = 'all';
let activeFilter = ALL_TYPES;

function describe(record) {
  const unit = record.currency === 'MYR' ? 'RM' : record.currency;

  switch (record.kind) {
    case 'buy':
    case 'sell':
      return `${formatQuantity(record.qty, 6)} ${record.asset} at ${unit} ${formatNumber(record.price, 2)} (${record.broker})`;
    case 'transfer':
      return `${record.fromAccount} to ${record.toAccount}`;
    case 'deposit':
      return `Into ${record.toAccount}`;
    case 'cashout':
      return `From ${record.fromAccount}`;
    default:
      return record.asset;
  }
}

function describeAmount(record) {
  switch (record.kind) {
    case 'buy':
      return formatForeign(record.amountFrom, record.currency);
    case 'sell':
      return formatForeign(record.amountTo, record.currency);
    case 'transfer': {
      const targetCurrency = findAccount(record.toAccount)?.currency ?? record.currency;
      return `${formatForeign(record.amountFrom, record.currency)} to ${formatForeign(record.amountTo, targetCurrency)}`;
    }
    case 'adjust':
      return `${record.qty >= 0 ? '+' : '-'}${formatForeign(Math.abs(record.qty), record.currency)}`;
    case 'mmf_gain':
      return `+${formatForeign(record.qty, record.currency)}`;
    default:
      return formatForeign(record.amountFrom, record.currency);
  }
}

const COLUMNS = Object.freeze([
  { label: 'Date', render: (row) => row.tradeDate },
  { label: 'Type', render: (row) => TYPE_NAMES[row.kind] ?? row.kind },
  { label: 'Details', render: describe },
  { label: 'Amount', numeric: true, render: describeAmount },
  { label: 'Fee', numeric: true, render: (row) => (row.fee > 0 ? formatForeign(row.fee, row.currency) : '') },
  { label: 'Value (RM)', numeric: true, render: (row) => formatNumber(row.totalMyr, 2) },
  {
    label: 'Realised P/L (RM)',
    numeric: true,
    render: (row) => (Math.abs(row.realisedPl) >= 0.005 ? formatSignedAmount(row.realisedPl) : ''),
    tone: (row) => row.realisedPl,
  },
  { label: 'Note', render: (row) => row.note },
]);

// Fills the type filter and calls onFilter when it changes.
export function initTransactionsView({ onFilter }) {
  const select = byId('transactions-filter');
  select.replaceChildren(
    createElement('option', { text: 'All types', attributes: { value: ALL_TYPES } }),
    ...ENTRY_KINDS.map(({ kind }) => createElement('option', { text: TYPE_NAMES[kind], attributes: { value: kind } })),
  );
  select.addEventListener('change', () => {
    activeFilter = select.value;
    onFilter();
  });
}

export function renderTransactionsView({ transactions, transactionsError }) {
  const rows = activeFilter === ALL_TYPES ? transactions : transactions.filter((record) => record.kind === activeFilter);

  renderTable('table-transactions', {
    columns: COLUMNS,
    rows,
    emptyMessage: transactionsError || 'No transactions yet. Choose Add entry to record one.',
  });
}
