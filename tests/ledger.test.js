import assert from 'node:assert/strict';
import { test } from 'node:test';

import { addUnits, planEntry, removeUnits } from '../public/js/logic/ledger.js';

const RATES = { 'fx:USD': 4, 'fx:USDT': 4.1 };

function position(broker, asset, category, qty, costMyr, realisedPl = 0, id = 1) {
  return { id, category, broker, asset, qty, costMyr, realisedPl };
}

// A small portfolio: RM cash at Luno, USD cash at IBKR, USDT cash at Pionex, a BTC and a VOO holding.
function createPositions() {
  return [
    position('Luno', 'Luno Cash', 'Cash', 1000, 1000, 0, 1),
    position('Luno', 'BTC', 'Crypto', 2, 200000, 0, 2),
    position('IBKR', 'IBKR Cash', 'Cash', 1000, 3800, 0, 3), // bought at RM 3.80 per USD
    position('IBKR', 'VOO', 'Stocks', 2, 4800, 0, 4),
    position('Pionex', 'Pionex Cash', 'Cash', 500, 2000, 0, 5),
    position('Bank', 'Bank Cash', 'Cash', 5000, 5000, 0, 6),
    position('Moomoo', 'Moomoo MMF', 'MMF', 3000, 3000, 0, 7),
    position('Moomoo', 'Moomoo Cash', 'Cash', 0, 0, 0, 8),
  ];
}

const plan = (input) =>
  planEntry({ tradeDate: '2026-10-28', note: '', ...input }, { positions: createPositions(), marketPrices: RATES });
const after = (result, asset) => result.changes.find((change) => change.after.asset === asset)?.after;

// ---------- Building blocks ----------

test('addUnits grows quantity and cost', () => {
  const result = addUnits(position('Luno', 'BTC', 'Crypto', 2, 200000), 1, 120000);
  assert.equal(result.qty, 3);
  assert.equal(result.costMyr, 320000);
});

test('removeUnits uses the average cost and records the realised result', () => {
  const { position: result, realisedChange } = removeUnits(position('Luno', 'BTC', 'Crypto', 2, 200000), 1, 130000, 'x');
  assert.equal(result.qty, 1);
  assert.equal(result.costMyr, 100000);
  assert.equal(realisedChange, 30000);
  assert.equal(result.realisedPl, 30000);
});

test('removing everything closes the position cleanly', () => {
  const { position: result } = removeUnits(position('Luno', 'BTC', 'Crypto', 2, 200000), 2, 180000, 'x');
  assert.equal(result.qty, 0);
  assert.equal(result.costMyr, 0);
  assert.equal(result.realisedPl, -20000);
});

test('removeUnits refuses to go below zero', () => {
  assert.throws(() => removeUnits(position('Luno', 'BTC', 'Crypto', 2, 200000), 3, 1, 'Not enough.'), /Not enough/);
});

// ---------- Buying ----------

test('buying with RM: the asset grows and Luno Cash shrinks by the same amount', () => {
  const result = plan({ kind: 'buy', broker: 'Luno', asset: 'BTC', qty: 0.5, entryMode: 'price', price: 100000, fee: NaN, useCash: false });
  assert.equal(after(result, 'BTC').qty, 2.5);
  assert.equal(after(result, 'BTC').costMyr, 250000);
  assert.equal(result.changes.length, 1);

  const small = plan({ kind: 'buy', broker: 'Luno', asset: 'BTC', qty: 0.001, entryMode: 'price', price: 100000, fee: NaN, useCash: true });
  assert.equal(after(small, 'Luno Cash').qty, 900);
  assert.equal(after(small, 'Luno Cash').costMyr, 900);
  assert.equal(after(small, 'Luno Cash').realisedPl, 0);
});

test('the fee is added to the cost of a purchase and taken from cash', () => {
  const result = plan({ kind: 'buy', broker: 'Luno', asset: 'BTC', qty: 0.001, entryMode: 'price', price: 100000, fee: 2, useCash: true });
  assert.equal(after(result, 'BTC').costMyr, 200102);
  assert.equal(after(result, 'Luno Cash').qty, 898);
  assert.equal(result.record.fee, 2);
  assert.equal(result.record.totalMyr, 102);
});

test('entering the total amount calculates the cost per unit (fee included)', () => {
  const result = plan({ kind: 'buy', broker: 'Luno', asset: 'BTC', qty: 0.002, entryMode: 'total', total: 300, fee: 1, useCash: true });
  assert.equal(after(result, 'BTC').costMyr, 200300);
  assert.equal(result.record.price, 149500); // (300 - 1) / 0.002
  assert.ok(result.previewLines.some((item) => item.label === 'Cost per unit, fee included' && item.value === 'RM 150,000.00'));
  assert.equal(after(result, 'Luno Cash').qty, 700);
});

test('buying at IBKR is typed in USD, saved in RM and paid from IBKR Cash in USD', () => {
  const result = plan({ kind: 'buy', broker: 'IBKR', asset: 'VOO', qty: 1, entryMode: 'price', price: 600, fee: 1, useCash: true });
  const voo = after(result, 'VOO');
  assert.equal(voo.qty, 3);
  assert.equal(voo.costMyr, 4800 + 601 * 4);
  const cash = after(result, 'IBKR Cash');
  assert.equal(cash.qty, 399); // 1000 - 601 USD
  assert.equal(cash.costMyr, 1516.2); // 3800 x 399 / 1000
  assert.equal(cash.realisedPl, 120.2); // exchange gain on the 601 dollars spent: 601 x (4 - 3.8)
  assert.equal(result.record.currency, 'USD');
  assert.equal(result.record.rate, 4);
});

test('buying at Pionex uses USDT and the USDT rate', () => {
  const result = plan({ kind: 'buy', broker: 'Pionex', asset: 'BTC', qty: 0.01, entryMode: 'price', price: 7000, fee: NaN, useCash: true });
  assert.equal(after(result, 'BTC').costMyr, 70 * 4.1);
  assert.equal(after(result, 'Pionex Cash').qty, 430);
});

test('a purchase that the broker cash cannot cover is refused', () => {
  assert.throws(
    () => plan({ kind: 'buy', broker: 'Luno', asset: 'BTC', qty: 1, entryMode: 'price', price: 100000, fee: NaN, useCash: true }),
    /Luno Cash holds RM 1,000.00 but this purchase needs RM 100,000.00/,
  );
});

test('the cash option can be turned off for old purchases', () => {
  const result = plan({ kind: 'buy', broker: 'Luno', asset: 'BTC', qty: 1, entryMode: 'price', price: 100000, fee: NaN, useCash: false });
  assert.equal(result.changes.length, 1);
});

// ---------- Selling ----------

test('selling adds the proceeds to the broker cash and records realised profit', () => {
  const result = plan({ kind: 'sell', broker: 'Luno', asset: 'BTC', qty: 1, entryMode: 'price', price: 130000, fee: 100, useCash: true });
  assert.equal(after(result, 'BTC').qty, 1);
  assert.equal(after(result, 'BTC').realisedPl, 29900); // 129,900 received - 100,000 cost
  assert.equal(after(result, 'Luno Cash').qty, 1000 + 129900);
  assert.equal(result.record.realisedPl, 29900);
});

test('selling at IBKR pays USD into IBKR Cash', () => {
  const result = plan({ kind: 'sell', broker: 'IBKR', asset: 'VOO', qty: 1, entryMode: 'price', price: 650, fee: 2, useCash: true });
  assert.equal(after(result, 'IBKR Cash').qty, 1648);
  assert.equal(after(result, 'VOO').realisedPl, 648 * 4 - 2400);
});

test('selling more than you hold is refused', () => {
  assert.throws(
    () => plan({ kind: 'sell', broker: 'Luno', asset: 'BTC', qty: 3, entryMode: 'price', price: 1, fee: NaN, useCash: true }),
    /less than/,
  );
});

test('a fee larger than the amount is refused', () => {
  assert.throws(
    () => plan({ kind: 'sell', broker: 'Luno', asset: 'BTC', qty: 1, entryMode: 'price', price: 10, fee: 50, useCash: true }),
    /fee is larger/,
  );
});

test('invalid trade inputs give clear messages', () => {
  const base = { kind: 'buy', broker: 'Luno', asset: 'BTC', entryMode: 'price', price: 1, fee: NaN, useCash: false };
  assert.throws(() => plan({ ...base, qty: 0 }), /greater than zero/);
  assert.throws(() => plan({ ...base, qty: 1, price: -1 }), /zero or more/);
  assert.throws(() => plan({ ...base, qty: 1, fee: -1 }), /fee of zero or more/);
  assert.throws(() => plan({ ...base, qty: 1, asset: 'Bank Cash' }), /Choose an asset/);
  assert.throws(() => plan({ ...base, qty: 1, entryMode: 'total', total: NaN }), /total amount/);
  assert.throws(() => plan({ ...base, qty: 1, tradeDate: 'yesterday' }), /valid date/);
});

test('a missing exchange rate blocks USD entries only', () => {
  const input = { tradeDate: '2026-10-28', kind: 'buy', broker: 'IBKR', asset: 'VOO', qty: 1, entryMode: 'price', price: 1, fee: NaN, useCash: false };
  assert.throws(() => planEntry(input, { positions: createPositions(), marketPrices: {} }), /USD to RM rate is not available/);
  assert.doesNotThrow(() => planEntry({ ...input, broker: 'Luno', asset: 'BTC' }, { positions: createPositions(), marketPrices: {} }));
});

// ---------- Transfers, deposits, cash out ----------

test('a transfer between two RM accounts moves money without profit', () => {
  const result = plan({ kind: 'transfer', fromAccount: 'Bank Cash', toAccount: 'Luno Cash', amountSent: 2000, amountReceived: 2000 });
  assert.equal(after(result, 'Bank Cash').qty, 3000);
  assert.equal(after(result, 'Luno Cash').qty, 3000);
  assert.equal(after(result, 'Luno Cash').costMyr, 3000);
  assert.equal(result.record.realisedPl, 0);
  assert.equal(result.record.fromAccount, 'Bank Cash');
  assert.equal(result.record.toAccount, 'Luno Cash');
});

test('a smaller amount received shows the transfer fee as a loss', () => {
  const result = plan({ kind: 'transfer', fromAccount: 'Bank Cash', toAccount: 'Luno Cash', amountSent: 1000, amountReceived: 995 });
  assert.equal(result.record.realisedPl, -5);
});

test('transferring RM to IBKR creates USD cash with the RM cost paid', () => {
  const result = plan({ kind: 'transfer', fromAccount: 'Bank Cash', toAccount: 'IBKR Cash', amountSent: 2000, amountReceived: 490 });
  const ibkrCash = after(result, 'IBKR Cash');
  assert.equal(ibkrCash.qty, 1490);
  assert.equal(ibkrCash.costMyr, 3800 + 490 * 4); // cost is valued at today's rate
  assert.equal(result.record.currency, 'MYR');
  assert.equal(result.record.amountTo, 490);
});

test('moving USD back to RM realises the exchange effect', () => {
  // 100 USD cost RM 380 (3.80 each). They are worth RM 400 at 4.00, so RM 20 is realised.
  const result = plan({ kind: 'transfer', fromAccount: 'IBKR Cash', toAccount: 'Bank Cash', amountSent: 100, amountReceived: 400 });
  assert.equal(after(result, 'IBKR Cash').qty, 900);
  assert.equal(result.record.realisedPl, 20);
});

test('a transfer needs two different accounts and enough money', () => {
  assert.throws(() => plan({ kind: 'transfer', fromAccount: 'Bank Cash', toAccount: 'Bank Cash', amountSent: 1, amountReceived: 1 }), /two different/);
  assert.throws(() => plan({ kind: 'transfer', fromAccount: 'Bank Cash', toAccount: 'Luno Cash', amountSent: 9999, amountReceived: 9999 }), /less than/);
  assert.throws(() => plan({ kind: 'transfer', fromAccount: 'Bank Cash', toAccount: '', amountSent: 1, amountReceived: 1 }), /Choose an account/);
});

test('cash can move into and out of the money market fund', () => {
  const result = plan({ kind: 'transfer', fromAccount: 'Bank Cash', toAccount: 'Moomoo MMF', amountSent: 1000, amountReceived: 1000 });
  assert.equal(after(result, 'Moomoo MMF').qty, 4000);
  assert.equal(after(result, 'Moomoo MMF').costMyr, 4000);
});

test('a deposit from outside adds cash and a cash out takes it away', () => {
  const income = plan({ kind: 'deposit', account: 'Bank Cash', amount: 3500, note: 'Salary' });
  assert.equal(after(income, 'Bank Cash').qty, 8500);
  assert.equal(income.record.fromAccount, 'Outside');
  assert.equal(income.record.note, 'Salary');

  const spend = plan({ kind: 'cashout', account: 'Bank Cash', amount: 1200 });
  assert.equal(after(spend, 'Bank Cash').qty, 3800);
  assert.equal(spend.record.toAccount, 'Outside');
  assert.throws(() => plan({ kind: 'cashout', account: 'Bank Cash', amount: 99999 }), /less than/);
});

test('a deposit into IBKR is typed in USD', () => {
  const result = plan({ kind: 'deposit', account: 'IBKR Cash', amount: 200 });
  assert.equal(after(result, 'IBKR Cash').qty, 1200);
  assert.equal(after(result, 'IBKR Cash').costMyr, 3800 + 800);
  assert.equal(result.record.currency, 'USD');
});

// ---------- MMF gain and adjustment ----------

test('an MMF gain raises the balance but not the principal', () => {
  const result = plan({ kind: 'mmf_gain', account: 'Moomoo MMF', amount: 12.5 });
  const mmf = after(result, 'Moomoo MMF');
  assert.equal(mmf.qty, 3012.5);
  assert.equal(mmf.costMyr, 3000);
  assert.throws(() => plan({ kind: 'mmf_gain', account: 'Bank Cash', amount: 1 }), /Choose an account/);
});

test('adjusting a balance sets the quantity and keeps the average cost', () => {
  const result = plan({ kind: 'adjust', account: 'Luno Cash', balance: 0.11 });
  assert.equal(after(result, 'Luno Cash').qty, 0.11);
  assert.equal(after(result, 'Luno Cash').costMyr, 0.11);
  assert.equal(result.record.note, 'Balance set to 0.11');
  assert.throws(() => plan({ kind: 'adjust', account: 'Luno Cash', balance: 1000 }), /already has this value/);
});

test('adjusting an account that does not exist yet creates it', () => {
  const result = plan({ kind: 'adjust', account: 'Moomoo Cash', balance: 250 });
  assert.equal(result.changes[0].before.id, 8);
  assert.equal(after(result, 'Moomoo Cash').qty, 250);
});

test('an unknown entry type is refused', () => {
  assert.throws(() => plan({ kind: 'gift' }), /Choose an entry type/);
});
