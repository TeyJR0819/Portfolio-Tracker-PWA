// The "Add transaction" drawer: choose buy or sell, enter the amounts, preview the result, save.

import { applyTransaction, findRate, roundTo } from '../logic/calculations.js';
import {
  createEmptyPosition,
  findPosition,
  getAssetsForBroker,
  getBrokers,
  getEntryCurrency,
  isFixedPriceAsset,
} from '../logic/catalog.js';
import { formatForeign, formatNumber, formatQuantity, formatRm, formatSignedRm } from '../logic/format.js';
import { savePosition } from '../services/database.js';
import { getPortfolio, getState } from '../state.js';
import { byId, createElement } from './dom.js';
import { createOverlay } from './overlay.js';

function toOption(value) {
  return createElement('option', { text: value, attributes: { value } });
}

function parseNumber(text) {
  return text.trim() === '' ? Number.NaN : Number(text);
}

export function initTransactionDrawer({ onSaved }) {
  const overlay = createOverlay('transaction-drawer');
  const form = byId('transaction-form');
  const brokerSelect = byId('transaction-broker');
  const assetSelect = byId('transaction-asset');
  const quantityInput = byId('transaction-quantity');
  const priceInput = byId('transaction-price');
  const submitButton = byId('transaction-submit');
  const errorBox = byId('transaction-error');
  const previewBox = byId('transaction-preview');
  let isSaving = false;

  const getAction = () => form.elements.action.value;
  const isFixedPrice = () => isFixedPriceAsset(assetSelect.value);

  function showError(message) {
    errorBox.textContent = message;
    errorBox.hidden = !message;
  }

  // Prices typed in USD or USDT are converted to RM here. The rest of the app only sees RM.
  function readInput() {
    const broker = brokerSelect.value;
    const asset = assetSelect.value;
    const currency = getEntryCurrency(broker, asset);
    const rate = currency ? findRate(getState().marketPrices, currency) : 1;
    const enteredPrice = isFixedPrice() ? 1 : parseNumber(priceInput.value);

    return {
      action: getAction(),
      broker,
      asset,
      currency,
      rate,
      qty: parseNumber(quantityInput.value),
      enteredPrice,
      unitPrice: enteredPrice * (rate ?? Number.NaN),
    };
  }

  function getRateProblem(input) {
    return input.currency && !input.rate
      ? `The ${input.currency} to RM rate is not available. Press Refresh on the dashboard and try again.`
      : '';
  }

  function getCurrentPosition(input) {
    return findPosition(getState().positions, input.broker, input.asset) ?? createEmptyPosition(input.broker, input.asset);
  }

  function addPreviewLine(label, value) {
    const line = createElement('div', { className: 'preview-line' });
    line.append(createElement('dt', { text: label }), createElement('dd', { text: value }));
    previewBox.append(line);
  }

  function updatePreview() {
    previewBox.replaceChildren();
    previewBox.hidden = true;
    showError('');

    const input = readInput();
    const rateProblem = getRateProblem(input);
    if (rateProblem) {
      showError(rateProblem);
      return;
    }
    if (Number.isNaN(input.qty) || Number.isNaN(input.unitPrice)) return;

    try {
      const position = getCurrentPosition(input);
      const { updatedPosition, totalAmount, realisedChange } = applyTransaction(position, input);
      const fixed = isFixedPrice();

      if (input.currency) {
        addPreviewLine(`Total (${input.currency})`, formatForeign(input.qty * input.enteredPrice, input.currency));
        addPreviewLine('Exchange rate', `1 ${input.currency} = RM ${formatNumber(input.rate, 4)}`);
        addPreviewLine('Total (RM)', formatRm(totalAmount));
      } else {
        addPreviewLine('Total', formatRm(totalAmount));
      }
      addPreviewLine(fixed ? 'New balance' : 'New quantity', fixed ? formatRm(updatedPosition.qty) : formatQuantity(updatedPosition.qty, 6));
      if (!fixed && updatedPosition.qty > 0) {
        addPreviewLine('New average cost', formatRm(updatedPosition.costMyr / updatedPosition.qty));
      }
      if (input.action === 'sell' && !fixed) {
        addPreviewLine('Realised P/L from this sale', formatSignedRm(realisedChange));
      }
      previewBox.hidden = false;
    } catch (error) {
      showError(error.message);
    }
  }

  function updateHoldingHint() {
    const position = findPosition(getState().positions, brokerSelect.value, assetSelect.value);
    const fixed = isFixedPrice();
    const held = position?.qty ?? 0;
    byId('transaction-holding').textContent = fixed
      ? `Current balance: ${formatRm(held)}`
      : `Currently held: ${formatQuantity(held, 6)} ${assetSelect.value}`;
  }

  function syncFields({ resetPrice }) {
    const fixed = isFixedPrice();
    byId('transaction-price-field').hidden = fixed;
    byId('transaction-price-label').textContent = `Price per unit (${getEntryCurrency(brokerSelect.value, assetSelect.value) ?? 'RM'})`;
    byId('transaction-quantity-label').textContent = fixed ? 'Amount (RM)' : 'Quantity';
    quantityInput.placeholder = fixed ? '0.00' : '0.000000';
    updateHoldingHint();

    if (resetPrice) {
      const reference = getPortfolio().holdings.find(
        (holding) => holding.asset === assetSelect.value && holding.priceSource === 'market',
      );
      const currency = getEntryCurrency(brokerSelect.value, assetSelect.value);
      const rate = currency ? findRate(getState().marketPrices, currency) : 1;
      priceInput.value = !fixed && reference && rate ? String(roundTo(reference.unitPrice / rate, 4)) : '';
    }
    updatePreview();
  }

  function populateAssets() {
    assetSelect.replaceChildren(...getAssetsForBroker(brokerSelect.value).map((entry) => toOption(entry.asset)));
    syncFields({ resetPrice: true });
  }

  function setSaving(value) {
    isSaving = value;
    submitButton.disabled = value;
    submitButton.textContent = value ? 'Saving' : 'Save transaction';
  }

  brokerSelect.replaceChildren(...getBrokers().map(toOption));
  brokerSelect.addEventListener('change', populateAssets);
  assetSelect.addEventListener('change', () => syncFields({ resetPrice: true }));
  form.elements.action.forEach((radio) => radio.addEventListener('change', updatePreview));
  [quantityInput, priceInput].forEach((input) => input.addEventListener('input', updatePreview));

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (isSaving) return;
    showError('');

    try {
      const input = readInput();
      const rateProblem = getRateProblem(input);
      if (rateProblem) throw new Error(rateProblem);
      const existing = findPosition(getState().positions, input.broker, input.asset);
      if (input.action === 'sell' && !existing) throw new Error('You hold nothing here to sell.');

      const { updatedPosition } = applyTransaction(existing ?? createEmptyPosition(input.broker, input.asset), input);
      setSaving(true);
      const saved = await savePosition(updatedPosition);
      onSaved(saved);
      overlay.close();
    } catch (error) {
      showError(error.message);
    } finally {
      setSaving(false);
    }
  });

  function open() {
    form.reset();
    form.elements.action.value = 'buy';
    brokerSelect.value = getBrokers()[0];
    populateAssets();
    showError('');
    overlay.open({ focusSelector: '#transaction-broker' });
  }

  return { open };
}
