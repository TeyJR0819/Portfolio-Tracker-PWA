// Compares the balances a broker reports with the quantities in the ledger.
// Pure functions: no network, no screen. The result tells the person where the two disagree.

export const MATCH_STATES = Object.freeze({
  match: 'match',
  differs: 'differs',
  missingInLedger: 'missing-in-ledger', // The broker holds it, the ledger does not.
  missingAtBroker: 'missing-at-broker', // The ledger holds it, the broker does not.
});

// Differences below this are rounding noise (brokers report up to 8 decimals).
const QUANTITY_TOLERANCE = 1e-6;

function keyOf(broker, asset) {
  return `${broker}|${asset}`;
}

// brokerBalances: [{ broker, asset, qty }]    syncedBrokers: names that have a successful sync
// positions:      [{ broker, asset, qty }]    only brokers that synced are compared
export function reconcileBalances({ brokerBalances, positions, syncedBrokers }) {
  const synced = new Set(syncedBrokers);
  const ledger = new Map();
  for (const position of positions) {
    if (!synced.has(position.broker)) continue;
    ledger.set(keyOf(position.broker, position.asset), position);
  }
  const reported = new Map(brokerBalances.filter((row) => synced.has(row.broker)).map((row) => [keyOf(row.broker, row.asset), row]));

  const rows = [];
  for (const key of new Set([...ledger.keys(), ...reported.keys()])) {
    const ledgerQty = ledger.get(key)?.qty ?? 0;
    const brokerQty = reported.get(key)?.qty ?? 0;
    const { broker, asset } = ledger.get(key) ?? reported.get(key);
    if (ledgerQty === 0 && brokerQty === 0) continue;

    let state = MATCH_STATES.match;
    if (!reported.has(key) || brokerQty === 0) state = MATCH_STATES.missingAtBroker;
    else if (!ledger.has(key) || ledgerQty === 0) state = MATCH_STATES.missingInLedger;
    else if (Math.abs(brokerQty - ledgerQty) > QUANTITY_TOLERANCE) state = MATCH_STATES.differs;

    rows.push({ broker, asset, ledgerQty, brokerQty, difference: brokerQty - ledgerQty, state });
  }
  return rows.sort((a, b) => a.broker.localeCompare(b.broker) || a.asset.localeCompare(b.asset));
}
