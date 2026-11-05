// The "Add entry" drawer. One form for every kind of entry (see ENTRY_KINDS in logic/ledger.js).
// This file only reads the form, shows or hides fields, and shows the preview.
// The rules and the maths live in logic/ledger.js.

import { BASE_CURRENCY } from '../config.js';
import { findRate, roundTo } from '../logic/calculations.js';
import {
  findAccount,
  findAsset,
  getAccounts,
  getBrokerCurrency,
  getCashAssetForBroker,
  getTradableAssetsForBroker,
  getTradingBrokers,
} from '../logic/catalog.js';
import { formatForeign, formatQuantity } from '../logic/format.js';
import { ENTRY_KINDS, planEntry } from '../logic/ledger.js';
import { saveEntry } from '../services/database.js';
import { getBasePortfolio, getState } from '../state.js';
import { byId, createElement } from './dom.js';
import { createOverlay } from './overlay.js';

const TRADE_KINDS = ['buy', 'sell'];

const unitName = (currency) => (currency === BASE_CURRENCY ? 'RM' : currency);

function toOption(value, text = value) {
  return createElement('option', { text, attributes: { value } });
}

function parseNumber(text) {
  return text.trim() === '' ? Number.NaN : Number(text);
}

// Today's date in the person's own time zone, as YYYY-MM-DD.
function getToday() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

export function initEntryDrawer({ onSaved }) {
  const overlay = createOverlay('entry-drawer');
  const form = byId('entry-form');
  const fields = {
    kind: byId('entry-kind'),
    date: byId('entry-date'),
    note: byId('entry-note'),
    broker: byId('entry-broker'),
    asset: byId('entry-asset'),
    quantity: byId('entry-quantity'),
    price: byId('entry-price'),
    total: byId('entry-total'),
    fee: byId('entry-fee'),
    useCash: byId('entry-use-cash'),
    from: byId('entry-from'),
    to: byId('entry-to'),
    sent: byId('entry-sent'),
    received: byId('entry-received'),
    account: byId('entry-account'),
    amount: byId('entry-amount'),
    currency: byId('entry-currency'),
  };
  const submitButton = byId('entry-submit');
  const errorBox = byId('entry-error');
  const previewBox = byId('entry-preview');

  let isSaving = false;
  let isReceivedEdited = false;

  const getKind = () => fields.kind.value;
  const getMode = () => form.elements['entry-mode'].value;
  const isTrade = () => TRADE_KINDS.includes(getKind());
  const getPositions = () => getState().positions;
  const getEntryCurrency = () => fields.currency.value || BASE_CURRENCY;
  const getRate = (currency) => (currency === BASE_CURRENCY ? 1 : findRate(getState().marketPrices, currency));

  // ---------- Reading and checking ----------

  function readInput() {
    return {
      kind: getKind(),
      tradeDate: fields.date.value,
      note: fields.note.value,
      broker: fields.broker.value,
      asset: fields.asset.value,
      qty: parseNumber(fields.quantity.value),
      entryMode: getMode(),
      price: parseNumber(fields.price.value),
      total: parseNumber(fields.total.value),
      fee: parseNumber(fields.fee.value),
      useCash: fields.useCash.checked,
      fromAccount: fields.from.value,
      toAccount: fields.to.value,
      amountSent: parseNumber(fields.sent.value),
      amountReceived: parseNumber(fields.received.value),
      account: fields.account.value,
      amount: parseNumber(fields.amount.value),
      balance: parseNumber(fields.amount.value),
      entryCurrency: getEntryCurrency(),
    };
  }

  // The preview waits until the needed boxes are filled, so empty boxes never show an error.
  function isComplete(input) {
    if (isTrade()) {
      const amountBox = input.entryMode === 'total' ? input.total : input.price;
      return !Number.isNaN(input.qty) && !Number.isNaN(amountBox);
    }
    if (input.kind === 'transfer') return !Number.isNaN(input.amountSent) && !Number.isNaN(input.amountReceived);
    return !Number.isNaN(input.amount);
  }

  function plan(input) {
    return planEntry(input, { positions: getPositions(), marketPrices: getState().marketPrices });
  }

  function showError(message) {
    errorBox.textContent = message;
    errorBox.hidden = !message;
  }

  function updatePreview() {
    previewBox.replaceChildren();
    previewBox.hidden = true;
    showError('');

    const input = readInput();
    if (!isComplete(input)) return;

    try {
      const { previewLines } = plan(input);
      previewLines.forEach(({ label, value }) => {
        const row = createElement('div', { className: 'preview-line' });
        row.append(createElement('dt', { text: label }), createElement('dd', { text: value }));
        previewBox.append(row);
      });
      previewBox.hidden = false;
    } catch (error) {
      showError(error.message);
    }
  }

  // ---------- Labels and hints that depend on the choice ----------

  function setLabel(id, text) {
    byId(id).textContent = text;
  }

  function findHeldQty(broker, asset) {
    return getPositions().find((position) => position.broker === broker && position.asset === asset)?.qty ?? 0;
  }

  function updateTradeLabels() {
    const isBuy = getKind() === 'buy';
    const currency = getBrokerCurrency(fields.broker.value);
    const unit = unitName(getEntryCurrency());
    const cashAsset = getCashAssetForBroker(fields.broker.value);

    setLabel('entry-price-label', `Price per unit (${unit})`);
    setLabel('entry-total-label', isBuy ? `Total amount paid (${unit})` : `Total amount received (${unit})`);
    setLabel('entry-fee-label', `Fee (${unit}, optional)`);
    setLabel('entry-use-cash-label', isBuy ? `Deduct from ${cashAsset}` : `Add proceeds to ${cashAsset}`);
    byId('entry-use-cash-field').hidden = !cashAsset;
    if (!cashAsset) fields.useCash.checked = false;

    const held = `Held: ${formatQuantity(findHeldQty(fields.broker.value, fields.asset.value), 6)} ${fields.asset.value}`;
    const cash = cashAsset ? `. ${cashAsset}: ${formatForeign(findHeldQty(fields.broker.value, cashAsset), currency)}` : '';
    byId('entry-holding').textContent = held + cash;
  }

  function updateTransferLabels() {
    const from = findAccount(fields.from.value);
    const to = findAccount(fields.to.value);
    setLabel('entry-sent-label', `Amount sent (${unitName(from?.currency ?? BASE_CURRENCY)})`);
    setLabel('entry-received-label', `Amount received (${unitName(to?.currency ?? BASE_CURRENCY)})`);
  }

  function updateAccountLabels() {
    const account = findAccount(fields.account.value);
    const unit = unitName(getEntryCurrency());
    const labels = {
      deposit: `Amount deposited (${unit})`,
      cashout: `Amount taken out (${unit})`,
      mmf_gain: 'Gain (RM)',
      adjust: `New balance (${unit})`,
    };
    setLabel('entry-amount-label', labels[getKind()] ?? 'Amount');
    byId('entry-account-help').textContent = account
      ? `Current balance: ${formatForeign(findHeldQty(account.broker, account.asset), account.currency)}`
      : '';
  }

  // The received amount follows the sent amount at today's rate until the person edits it.
  function fillReceivedAmount() {
    if (isReceivedEdited) return;
    const from = findAccount(fields.from.value);
    const to = findAccount(fields.to.value);
    const sent = parseNumber(fields.sent.value);
    const rateFrom = from && getRate(from.currency);
    const rateTo = to && getRate(to.currency);

    fields.received.value = !Number.isNaN(sent) && rateFrom && rateTo ? String(roundTo((sent * rateFrom) / rateTo, 2)) : '';
  }

  // Suggests the current market price, converted to the broker's currency.
  function fillMarketPrice() {
    const fixedPrice = findAsset(fields.asset.value)?.fixedPrice;
    if (fixedPrice) {
      fields.price.value = String(fixedPrice); // A money market fund is always RM 1 per unit.
      return;
    }
    const reference = getBasePortfolio().holdings.find(
      (holding) => holding.asset === fields.asset.value && holding.priceSource === 'market',
    );
    const rate = getRate(getEntryCurrency());
    fields.price.value = reference && rate ? String(roundTo(reference.unitPrice / rate, 4)) : '';
  }

  // ---------- Currency of the typed amounts ----------

  // The currency the chosen broker or account works in. Null when the amounts are not converted
  // (a transfer, an MMF gain, or an MMF buy or sell, which are fixed to their own currency).
  function getAccountCurrency() {
    if (isTrade()) return findAsset(fields.asset.value)?.category === 'MMF' ? null : getBrokerCurrency(fields.broker.value);
    if (['deposit', 'cashout', 'adjust'].includes(getKind())) return findAccount(fields.account.value)?.currency ?? null;
    return null;
  }

  // Offers RM and USD, plus the account's own currency when it is another one (USDT).
  // The account's own currency is chosen again whenever the broker, account or type changes.
  function syncCurrency({ reset }) {
    const accountCurrency = getAccountCurrency();
    byId('entry-currency-field').hidden = !accountCurrency;
    if (!accountCurrency) {
      fields.currency.replaceChildren();
      return;
    }

    const choices = [...new Set([BASE_CURRENCY, 'USD', accountCurrency])];
    const previous = fields.currency.value;
    fields.currency.replaceChildren(...choices.map((currency) => toOption(currency, unitName(currency))));
    fields.currency.value = !reset && choices.includes(previous) ? previous : accountCurrency;

    const entryCurrency = getEntryCurrency();
    const rate = getRate(entryCurrency);
    byId('entry-currency-help').textContent =
      entryCurrency === accountCurrency
        ? `This account works in ${unitName(accountCurrency)}.`
        : rate
          ? `This account works in ${unitName(accountCurrency)}. Amounts are converted at 1 ${entryCurrency} = RM ${rate.toFixed(4)}.`
          : 'The exchange rate is not available yet. Press Refresh and try again.';
  }

  // ---------- Choosing what to show ----------

  function fillAccountList(select, accounts) {
    const previous = select.value;
    select.replaceChildren(
      ...accounts.map((account) =>
        toOption(account.asset, account.currency === BASE_CURRENCY ? account.asset : `${account.asset} (${account.currency})`),
      ),
    );
    if (accounts.some((account) => account.asset === previous)) select.value = previous;
  }

  function populateAssets() {
    const entries = getTradableAssetsForBroker(fields.broker.value);
    fields.asset.replaceChildren(...entries.map((entry) => toOption(entry.asset)));
  }

  function showKind({ resetPrice = true, resetCurrency = true } = {}) {
    const kind = getKind();
    form.querySelectorAll('[data-kinds]').forEach((group) => {
      group.hidden = !group.dataset.kinds.split(' ').includes(kind);
    });

    const accounts = getAccounts();
    if (kind === 'mmf_gain') fillAccountList(fields.account, accounts.filter((account) => account.category === 'MMF'));
    else if (kind === 'deposit') fillAccountList(fields.account, accounts.filter((account) => account.broker === 'Bank'));
    else fillAccountList(fields.account, accounts);

    syncCurrency({ reset: resetCurrency });

    if (isTrade()) {
      updateTradeLabels();
      if (resetPrice) fillMarketPrice();
    } else if (kind === 'transfer') {
      updateTransferLabels();
      fillReceivedAmount();
    } else {
      updateAccountLabels();
    }
    updatePreview();
  }

  function showMode() {
    const isTotal = getMode() === 'total';
    byId('entry-price-field').hidden = isTotal;
    byId('entry-total-field').hidden = !isTotal;
    updatePreview();
  }

  // ---------- Saving ----------

  function setSaving(value) {
    isSaving = value;
    submitButton.disabled = value;
    submitButton.textContent = value ? 'Saving' : 'Save entry';
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (isSaving) return;
    showError('');

    try {
      const entryPlan = plan(readInput());
      setSaving(true);
      onSaved(await saveEntry(entryPlan));
      overlay.close();
    } catch (error) {
      showError(error.message);
    } finally {
      setSaving(false);
    }
  });

  // ---------- Events ----------

  fields.kind.replaceChildren(...ENTRY_KINDS.map(({ kind, label }) => toOption(kind, label)));
  fields.broker.replaceChildren(...getTradingBrokers().map((broker) => toOption(broker)));

  fields.kind.addEventListener('change', () => showKind());
  fields.broker.addEventListener('change', () => {
    populateAssets();
    showKind();
  });
  fields.asset.addEventListener('change', () => showKind({ resetCurrency: false }));
  fields.currency.addEventListener('change', () => showKind({ resetCurrency: false }));
  form.elements['entry-mode'].forEach((radio) => radio.addEventListener('change', showMode));

  fields.from.addEventListener('change', () => showKind());
  fields.to.addEventListener('change', () => showKind());
  fields.account.addEventListener('change', () => showKind());
  fields.received.addEventListener('input', () => {
    isReceivedEdited = true;
  });
  fields.sent.addEventListener('input', () => {
    fillReceivedAmount();
    updatePreview();
  });

  [fields.quantity, fields.price, fields.total, fields.fee, fields.received, fields.amount, fields.date, fields.note].forEach(
    (input) => input.addEventListener('input', updatePreview),
  );
  fields.useCash.addEventListener('change', updatePreview);

  function open({ kind = 'buy' } = {}) {
    form.reset();
    isReceivedEdited = false;
    fields.kind.value = kind;
    fields.date.value = getToday();
    fields.useCash.checked = true;

    const accounts = getAccounts();
    fillAccountList(fields.from, accounts);
    fillAccountList(fields.to, accounts);
    fields.to.value = accounts.find((account) => account.broker !== 'Bank')?.asset ?? accounts[0].asset;
    // Adding cash to a broker is a Transfer, and it starts from the bank.
    if (accounts.some((account) => account.asset === 'Bank Cash')) fields.from.value = 'Bank Cash';
    populateAssets();
    showMode();
    showKind();
    showError('');
    overlay.open({ focusSelector: '#entry-kind' });
  }

  return { open };
}
