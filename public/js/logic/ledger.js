// The ledger: turns one entry (a buy, a transfer, an MMF gain, ...) into
//   changes     : the new state of every balance that must be saved ({ before, after })
//   record      : one line for the transactions page
//   previewLines: what the form shows before saving
//
// Everything here is pure logic with no browser features, so it is tested in tests/ledger.test.js.
//
// Money rules
//   - Balances keep a quantity and a total cost in RM (costMyr).
//   - Taking units out uses the weighted-average cost. The difference between the RM value
//     received and the cost taken out is realised profit or loss.
//   - Cash at IBKR is counted in USD and cash at Pionex in USDT. Moving that cash realises the
//     exchange-rate effect, the same way a sale realises a price effect.

import { BASE_CURRENCY, MONEY_DECIMALS, QUANTITY_DECIMALS } from '../config.js';
import { QUANTITY_EPSILON, findRate, roundTo } from './calculations.js';
import {
  createEmptyPosition,
  findAccount,
  findAsset,
  findPosition,
  getBrokerCurrency,
  getCashAssetForBroker,
} from './catalog.js';
import { formatForeign, formatQuantity, formatRm, formatSignedRm } from './format.js';

export const ENTRY_KINDS = Object.freeze([
  { kind: 'buy', label: 'Buy' },
  { kind: 'sell', label: 'Sell' },
  { kind: 'transfer', label: 'Transfer between accounts' },
  { kind: 'deposit', label: 'Deposit from outside' },
  { kind: 'cashout', label: 'Cash out to outside' },
  { kind: 'mmf_gain', label: 'MMF gain' },
  { kind: 'adjust', label: 'Adjust balance' },
]);

export const OUTSIDE = 'Outside';

// ---------- Balance building blocks ----------

// Adds units that cost costMyr in total.
export function addUnits(position, qty, costMyr) {
  return {
    ...position,
    qty: roundTo(position.qty + qty, QUANTITY_DECIMALS),
    costMyr: roundTo(position.costMyr + costMyr, MONEY_DECIMALS),
  };
}

// Takes units out. valueMyr is the RM value received for them.
// Returns the new position and the realised profit or loss of this step.
export function removeUnits(position, qty, valueMyr, shortageMessage) {
  if (qty > position.qty + QUANTITY_EPSILON) throw new Error(shortageMessage);

  const removedQty = Math.min(qty, position.qty);
  const averageCost = position.qty > 0 ? position.costMyr / position.qty : 0;
  const costRemoved = averageCost * removedQty;
  const remainingQty = roundTo(position.qty - removedQty, QUANTITY_DECIMALS);
  const isClosed = remainingQty <= QUANTITY_EPSILON;
  const realisedChange = valueMyr - costRemoved;

  return {
    realisedChange,
    position: {
      ...position,
      qty: isClosed ? 0 : remainingQty,
      costMyr: isClosed ? 0 : roundTo(position.costMyr - costRemoved, MONEY_DECIMALS),
      realisedPl: roundTo(position.realisedPl + realisedChange, MONEY_DECIMALS),
    },
  };
}

// ---------- Input checks ----------

function requirePositive(value, message) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(message);
  return value;
}

function requireZeroOrMore(value, message) {
  if (!Number.isFinite(value) || value < 0) throw new Error(message);
  return value;
}

// An empty fee box counts as no fee.
function readFee(value) {
  return value === undefined || value === null || Number.isNaN(value)
    ? 0
    : requireZeroOrMore(value, 'Enter a fee of zero or more.');
}

function readDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '') || Number.isNaN(Date.parse(value))) {
    throw new Error('Choose a valid date.');
  }
  return value;
}

function readAccount(assetName, allowedCategories = ['Cash', 'MMF']) {
  const account = findAccount(assetName);
  if (!account || !allowedCategories.includes(account.category)) throw new Error('Choose an account.');
  return account;
}

// ---------- Context ----------

function createContext(positions, marketPrices) {
  return {
    getPosition: (broker, asset) => findPosition(positions, broker, asset) ?? createEmptyPosition(broker, asset),
    rateFor(currency) {
      if (currency === BASE_CURRENCY) return 1;
      const rate = findRate(marketPrices, currency);
      if (!rate) throw new Error(`The ${currency} to RM rate is not available. Press Refresh and try again.`);
      return rate;
    },
  };
}

function buildRecord(input, fields) {
  return {
    tradeDate: readDate(input.tradeDate),
    kind: input.kind,
    broker: '',
    asset: '',
    qty: 0,
    price: 0,
    currency: BASE_CURRENCY,
    fee: 0,
    rate: 1,
    totalMyr: 0,
    fromAccount: '',
    toAccount: '',
    amountFrom: 0,
    amountTo: 0,
    realisedPl: 0,
    note: String(input.note ?? '').trim().slice(0, 200),
    externalId: String(input.externalId ?? ''), // The broker's trade id for an imported trade, otherwise empty.
    ...fields,
  };
}

const line = (label, value) => ({ label, value });

function rateLine(currency, rate) {
  return currency === BASE_CURRENCY ? [] : [line('Exchange rate', `1 ${currency} = RM ${rate.toFixed(4)}`)];
}

// ---------- Buy and sell ----------

// Inputs: broker, asset, qty, entryMode ('price' or 'total'), price, total, fee, useCash.
//   price mode: the trade value is qty x price. A buy costs value + fee; a sale pays value - fee.
//   total mode: "total" is the cash that actually left (buy) or arrived (sale), fee included.
function planTrade(input, context) {
  const isBuy = input.kind === 'buy';
  const entry = findAsset(input.asset);
  if (!entry || !['Crypto', 'Stocks'].includes(entry.category)) throw new Error('Choose an asset to trade.');

  const currency = getBrokerCurrency(input.broker);
  const rate = context.rateFor(currency);
  const qty = requirePositive(input.qty, 'Enter a quantity greater than zero.');
  const fee = readFee(input.fee);

  let tradeValue;
  let cashAmount;
  if (input.entryMode === 'total') {
    cashAmount = requirePositive(input.total, 'Enter the total amount.');
    tradeValue = isBuy ? cashAmount - fee : cashAmount + fee;
  } else {
    const price = requireZeroOrMore(input.price, 'Enter a price of zero or more.');
    tradeValue = qty * price;
    cashAmount = isBuy ? tradeValue + fee : tradeValue - fee;
  }
  if (tradeValue < 0 || cashAmount < 0) throw new Error('The fee is larger than the amount.');

  const amountMyr = cashAmount * rate;
  const asset = context.getPosition(input.broker, input.asset);
  const changes = [];
  let realisedPl = 0;
  let assetAfter;

  if (isBuy) {
    assetAfter = addUnits(asset, qty, amountMyr);
  } else {
    const sale = removeUnits(asset, qty, amountMyr, `You hold ${formatQuantity(asset.qty, 6)} ${input.asset}, which is less than ${formatQuantity(qty, 6)}.`);
    assetAfter = sale.position;
    realisedPl += sale.realisedChange;
  }
  changes.push({ before: asset, after: assetAfter });

  let cashAfter = null;
  const cashAsset = getCashAssetForBroker(input.broker);
  if (input.useCash && cashAsset) {
    const cash = context.getPosition(input.broker, cashAsset);
    if (isBuy) {
      const payment = removeUnits(
        cash,
        cashAmount,
        amountMyr,
        `${cashAsset} holds ${formatForeign(cash.qty, currency)} but this purchase needs ${formatForeign(cashAmount, currency)}. Deposit cash first, or turn off the cash option.`,
      );
      cashAfter = payment.position;
      realisedPl += payment.realisedChange;
    } else {
      cashAfter = addUnits(cash, cashAmount, amountMyr);
    }
    changes.push({ before: cash, after: cashAfter });
  }

  const previewLines = [
    line('Price per unit', formatForeign(tradeValue / qty, currency)),
    ...(fee > 0 ? [line('Fee', formatForeign(fee, currency))] : []),
    line(isBuy ? 'Total paid' : 'Total received', formatForeign(cashAmount, currency)),
    line(isBuy ? 'Cost per unit, fee included' : 'Proceeds per unit, after fee', formatForeign(cashAmount / qty, currency)),
    ...rateLine(currency, rate),
    ...(currency === BASE_CURRENCY ? [] : [line('Total (RM)', formatRm(amountMyr))]),
    line('New quantity', formatQuantity(assetAfter.qty, 6)),
    ...(isBuy && assetAfter.qty > 0 ? [line('New average cost', formatRm(assetAfter.costMyr / assetAfter.qty))] : []),
    ...(isBuy ? [] : [line('Realised P/L', formatSignedRm(realisedPl))]),
    ...(cashAfter ? [line(`${cashAsset} after`, formatForeign(cashAfter.qty, currency))] : []),
  ];

  const record = buildRecord(input, {
    broker: input.broker,
    asset: input.asset,
    qty,
    price: tradeValue / qty,
    currency,
    fee,
    rate,
    totalMyr: amountMyr,
    realisedPl: roundTo(realisedPl, MONEY_DECIMALS),
    fromAccount: isBuy && cashAfter ? cashAsset : '',
    toAccount: !isBuy && cashAfter ? cashAsset : '',
    amountFrom: isBuy ? cashAmount : qty,
    amountTo: isBuy ? qty : cashAmount,
  });

  return { changes, record, previewLines };
}

// ---------- Transfer ----------

// Inputs: fromAccount, toAccount, amountSent (in the first account's currency),
// amountReceived (in the second account's currency).
function planTransfer(input, context) {
  const from = readAccount(input.fromAccount);
  const to = readAccount(input.toAccount);
  if (from.asset === to.asset) throw new Error('Choose two different accounts.');

  const sent = requirePositive(input.amountSent, 'Enter the amount sent.');
  const received = requirePositive(input.amountReceived, 'Enter the amount received.');
  const valueMyr = received * context.rateFor(to.currency);

  const source = context.getPosition(from.broker, from.asset);
  const target = context.getPosition(to.broker, to.asset);
  const removal = removeUnits(
    source,
    sent,
    valueMyr,
    `${from.asset} holds ${formatForeign(source.qty, from.currency)}, which is less than ${formatForeign(sent, from.currency)}.`,
  );
  const targetAfter = addUnits(target, received, valueMyr);

  const previewLines = [
    line('Sent', formatForeign(sent, from.currency)),
    line('Received', formatForeign(received, to.currency)),
    line('Value (RM)', formatRm(valueMyr)),
    ...(Math.abs(removal.realisedChange) >= 0.005 ? [line('Fee or exchange effect', formatSignedRm(removal.realisedChange))] : []),
    line(`${from.asset} after`, formatForeign(removal.position.qty, from.currency)),
    line(`${to.asset} after`, formatForeign(targetAfter.qty, to.currency)),
  ];

  const record = buildRecord(input, {
    currency: from.currency,
    totalMyr: valueMyr,
    fromAccount: from.asset,
    toAccount: to.asset,
    amountFrom: sent,
    amountTo: received,
    realisedPl: roundTo(removal.realisedChange, MONEY_DECIMALS),
  });

  return {
    changes: [
      { before: source, after: removal.position },
      { before: target, after: targetAfter },
    ],
    record,
    previewLines,
  };
}

// ---------- Deposit from outside and cash out to outside ----------

function planOutsideMovement(input, context) {
  const isDeposit = input.kind === 'deposit';
  const account = readAccount(input.account);
  const amount = requirePositive(input.amount, 'Enter an amount greater than zero.');
  const rate = context.rateFor(account.currency);
  const valueMyr = amount * rate;
  const position = context.getPosition(account.broker, account.asset);

  let after;
  let realisedChange = 0;
  if (isDeposit) {
    after = addUnits(position, amount, valueMyr);
  } else {
    const removal = removeUnits(
      position,
      amount,
      valueMyr,
      `${account.asset} holds ${formatForeign(position.qty, account.currency)}, which is less than ${formatForeign(amount, account.currency)}.`,
    );
    after = removal.position;
    realisedChange = removal.realisedChange;
  }

  const previewLines = [
    line(isDeposit ? 'Deposit' : 'Cash out', formatForeign(amount, account.currency)),
    ...rateLine(account.currency, rate),
    line('Value (RM)', formatRm(valueMyr)),
    ...(Math.abs(realisedChange) >= 0.005 ? [line('Exchange effect', formatSignedRm(realisedChange))] : []),
    line(`${account.asset} after`, formatForeign(after.qty, account.currency)),
  ];

  const record = buildRecord(input, {
    currency: account.currency,
    rate,
    totalMyr: valueMyr,
    fromAccount: isDeposit ? OUTSIDE : account.asset,
    toAccount: isDeposit ? account.asset : OUTSIDE,
    amountFrom: amount,
    amountTo: amount,
    realisedPl: roundTo(realisedChange, MONEY_DECIMALS),
  });

  return { changes: [{ before: position, after }], record, previewLines };
}

// ---------- MMF gain ----------

// The fund grows without any new money going in, so the gain is added to the balance only.
function planMmfGain(input, context) {
  const account = readAccount(input.account, ['MMF']);
  const gain = requirePositive(input.amount, 'Enter a gain greater than zero.');
  const position = context.getPosition(account.broker, account.asset);
  const after = addUnits(position, gain, 0);

  const previewLines = [
    line('Gain', formatRm(gain)),
    line('New balance', formatRm(after.qty)),
    line('Total gain so far', formatSignedRm(after.qty - after.costMyr)),
  ];

  const record = buildRecord(input, {
    broker: account.broker,
    asset: account.asset,
    qty: gain,
    totalMyr: gain,
    toAccount: account.asset,
    amountTo: gain,
  });

  return { changes: [{ before: position, after }], record, previewLines };
}

// ---------- Adjust balance ----------

// Sets a balance to the amount the broker or bank shows. The average cost per unit is kept.
function planAdjustment(input, context) {
  const account = readAccount(input.account);
  const balance = requireZeroOrMore(input.balance, 'Enter the balance (zero or more).');
  const position = context.getPosition(account.broker, account.asset);

  if (Math.abs(balance - position.qty) < QUANTITY_EPSILON) throw new Error('The balance already has this value.');

  const unitCost = position.qty > 0 ? position.costMyr / position.qty : context.rateFor(account.currency);
  const after = {
    ...position,
    qty: roundTo(balance, QUANTITY_DECIMALS),
    costMyr: roundTo(unitCost * balance, MONEY_DECIMALS),
  };
  const change = balance - position.qty;

  const previewLines = [
    line('Current balance', formatForeign(position.qty, account.currency)),
    line('New balance', formatForeign(balance, account.currency)),
    line('Change', `${change > 0 ? '+' : '-'}${formatForeign(Math.abs(change), account.currency)}`),
  ];

  const record = buildRecord(input, {
    broker: account.broker,
    asset: account.asset,
    qty: change,
    currency: account.currency,
    totalMyr: Math.abs(change) * unitCost,
    toAccount: account.asset,
    amountTo: balance,
    note: String(input.note ?? '').trim().slice(0, 200) || `Balance set to ${balance}`,
  });

  return { changes: [{ before: position, after }], record, previewLines };
}

// ---------- Entry point ----------

const PLANNERS = Object.freeze({
  buy: planTrade,
  sell: planTrade,
  transfer: planTransfer,
  deposit: planOutsideMovement,
  cashout: planOutsideMovement,
  mmf_gain: planMmfGain,
  adjust: planAdjustment,
});

// Throws an Error with a sentence for the user when the entry is not valid.
export function planEntry(input, { positions, marketPrices }) {
  const planner = PLANNERS[input.kind];
  if (!planner) throw new Error('Choose an entry type.');
  return planner(input, createContext(positions, marketPrices));
}
