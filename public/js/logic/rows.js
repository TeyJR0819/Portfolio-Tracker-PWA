// Translates between database rows (snake_case) and the objects the rest of the app uses (camelCase).
// Shared by the browser (services/database.js) and the Worker (src/ledger-store.js).

export function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

export function toPosition(row) {
  return {
    id: row.id,
    category: row.category,
    broker: row.broker,
    asset: row.asset,
    qty: toNumber(row.qty),
    costMyr: toNumber(row.cost_myr),
    realisedPl: toNumber(row.realised_pl),
  };
}

export function toDatabaseRow(position) {
  return {
    category: position.category,
    broker: position.broker,
    asset: position.asset,
    qty: position.qty,
    cost_myr: position.costMyr,
    realised_pl: position.realisedPl,
  };
}

export function toTransaction(row) {
  return {
    id: row.id,
    tradeDate: row.trade_date,
    kind: row.kind,
    broker: row.broker ?? '',
    asset: row.asset ?? '',
    qty: toNumber(row.qty),
    price: toNumber(row.price),
    currency: row.currency ?? 'MYR',
    fee: toNumber(row.fee),
    rate: toNumber(row.rate) || 1,
    totalMyr: toNumber(row.total_myr),
    fromAccount: row.from_account ?? '',
    toAccount: row.to_account ?? '',
    amountFrom: toNumber(row.amount_from),
    amountTo: toNumber(row.amount_to),
    realisedPl: toNumber(row.realised_pl),
    note: row.note ?? '',
    externalId: row.external_id ?? '',
  };
}

export function toTransactionRow(record) {
  return {
    trade_date: record.tradeDate,
    kind: record.kind,
    broker: record.broker,
    asset: record.asset,
    qty: record.qty,
    price: record.price,
    currency: record.currency,
    fee: record.fee,
    rate: record.rate,
    total_myr: record.totalMyr,
    from_account: record.fromAccount,
    to_account: record.toAccount,
    amount_from: record.amountFrom,
    amount_to: record.amountTo,
    realised_pl: record.realisedPl,
    note: record.note,
    external_id: record.externalId || null,
  };
}
