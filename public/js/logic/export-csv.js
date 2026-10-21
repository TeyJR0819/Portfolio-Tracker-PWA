// Builds and downloads the CSV file for the current portfolio view.

const HEADERS = [
  'Category',
  'Broker',
  'Asset',
  'Quantity',
  'Unit price (RM)',
  'Market value (RM)',
  'Cost basis (RM)',
  'Unrealised P/L (RM)',
  'Unrealised P/L (%)',
  'Realised P/L (RM)',
  'Price source',
];

// Text that starts with these characters could run as a formula in a spreadsheet.
const FORMULA_START = /^[=+\-@]/;

function escapeCell(value) {
  let text = String(value ?? '');
  if (FORMULA_START.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function buildCsv(holdings) {
  const rows = holdings.map((holding) => [
    holding.category,
    holding.broker,
    holding.asset,
    holding.qty.toFixed(6),
    holding.unitPrice.toFixed(2),
    holding.marketValue.toFixed(2),
    holding.costMyr.toFixed(2),
    holding.unrealisedPl.toFixed(2),
    holding.unrealisedPlPct.toFixed(2),
    holding.realisedPl.toFixed(2),
    holding.priceSource,
  ]);

  return [HEADERS, ...rows].map((row) => row.map(escapeCell).join(',')).join('\r\n');
}

export function downloadCsv(holdings, date = new Date()) {
  // The leading byte order mark helps Excel read the file as UTF-8.
  const blob = new Blob([`﻿${buildCsv(holdings)}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `portfolio-${date.toISOString().slice(0, 10)}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
