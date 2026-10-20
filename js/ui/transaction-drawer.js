// The "Add transaction" drawer: choose buy or sell, enter the amounts, preview the result, save.

import { applyTransaction, roundTo } from '../logic/calculations.js';
import {
  createEmptyPosition,
  findPosition,
  getAssetsForBroker,
  getBrokers,
  isFixedPriceAsset,
} from '../logic/catalog.js';
import { formatQuantity, formatRm, formatSignedRm } from '../logic/format.js';
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

  function readInput() {
    return {
      action: getAction(),
      broker: brokerSelect.value,
      asset: assetSelect.value,
      qty: parseNumber(quantityInput.value),
      unitPrice: isFixedPrice() ? 1 : parseNumber(priceInput.value),
    };
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
    if (Number.isNaN(input.qty) || Number.isNaN(input.unitPrice)) return;

    try {
      const position = getCurrentPosition(input);
      const { updatedPosition, totalAmount, realisedChange } = applyTransaction(position, input);
      const fixed = isFixedPrice();

      addPreviewLine('Total', formatRm(totalAmount));
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
    byId('transaction-quantity-label').textContent = fixed ? 'Amount (RM)' : 'Quantity';
    quantityInput.placeholder = fixed ? '0.00' : '0.000000';
    updateHoldingHint();

    if (resetPrice) {
      const reference = getPortfolio().holdings.find(
        (holding) => holding.asset === assetSelect.value && holding.priceSource === 'market',
      );
      priceInput.value = !fixed && reference ? String(roundTo(reference.unitPrice, 4)) : '';
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
