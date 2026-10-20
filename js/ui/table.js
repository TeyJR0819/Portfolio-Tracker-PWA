// Builds a data table from a column list. Text is always set with textContent,
// so values from the database can never run as HTML.
//
// Column fields:
//   label   : header text
//   render  : (row) => text shown in the cell
//   numeric : right-aligns the column
//   tone    : (row) => number; colours the cell green, red or neutral by sign
//   swatch  : (row) => colour for a small dot before the text
//   footer  : (totals) => text shown in the total row

import { getTone } from '../logic/format.js';
import { byId, createElement, setTone } from './dom.js';

function createCell(column, isFirst) {
  return createElement(isFirst ? 'th' : 'td', {
    className: column.numeric ? 'is-numeric' : '',
    attributes: isFirst ? { scope: 'row' } : {},
  });
}

function createRow(columns, getText, toneSource, swatchSource) {
  const row = createElement('tr');

  columns.forEach((column, index) => {
    const cell = createCell(column, index === 0);

    if (column.swatch && swatchSource) {
      const dot = createElement('span', { className: 'swatch' });
      dot.style.setProperty('--swatch-color', column.swatch(swatchSource));
      cell.append(dot);
    }

    cell.append(document.createTextNode(getText(column)));

    if (column.tone && toneSource) setTone(cell, getTone(column.tone(toneSource)));
    row.append(cell);
  });

  return row;
}

export function renderTable(tableId, { columns, rows, totals = null, emptyMessage = 'Nothing to show yet.' }) {
  const table = byId(tableId);

  const head = createElement('thead');
  const headRow = createElement('tr');
  columns.forEach((column) => {
    headRow.append(
      createElement('th', {
        text: column.label,
        className: column.numeric ? 'is-numeric' : '',
        attributes: { scope: 'col' },
      }),
    );
  });
  head.append(headRow);

  const body = createElement('tbody');
  if (rows.length === 0) {
    const emptyRow = createElement('tr');
    emptyRow.append(
      createElement('td', { className: 'table-empty', text: emptyMessage, attributes: { colspan: columns.length } }),
    );
    body.append(emptyRow);
  }
  rows.forEach((row) => {
    body.append(createRow(columns, (column) => column.render(row), row, row));
  });

  const sections = [head, body];

  if (totals && rows.length > 0) {
    const foot = createElement('tfoot');
    const hasFooter = (column) => typeof column.footer === 'function';
    const footRow = createRow(
      columns,
      (column) => (hasFooter(column) ? column.footer(totals) : ''),
      totals,
      null,
    );
    foot.append(footRow);
    sections.push(foot);
  }

  table.replaceChildren(...sections);
}
