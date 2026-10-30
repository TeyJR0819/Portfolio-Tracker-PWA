// First-time setup: asks for the Supabase details and a new PIN.
// When the Worker already supplies the Supabase details, only the PIN is asked.

import { isValidDatabaseUrl, isValidPin, saveCredentials, startSession } from '../services/auth.js';
import { testConnection } from '../services/database.js';
import { byId } from './dom.js';
import { createOverlay } from './overlay.js';

export function initSetupWizard({ onComplete }) {
  const overlay = createOverlay('setup-wizard', { dismissible: false });
  const form = byId('setup-form');
  const submitButton = byId('setup-submit');
  const errorBox = byId('setup-error');
  const pinInputs = [byId('setup-pin'), byId('setup-pin-confirm')];
  const databaseFields = document.querySelectorAll('[data-database-field]');

  function showError(message) {
    errorBox.textContent = message;
    errorBox.hidden = !message;
  }

  function setBusy(isBusy) {
    submitButton.disabled = isBusy;
    submitButton.textContent = isBusy ? 'Checking connection' : 'Save and continue';
  }

  function validate({ databaseUrl, databaseKey, pin, pinConfirm }) {
    if (!isValidDatabaseUrl(databaseUrl)) return 'The project URL must start with https://.';
    if (databaseKey.length < 20) return 'The anon key looks too short. Copy the whole key.';
    if (!isValidPin(pin)) return 'The PIN must contain exactly 4 digits.';
    if (pin !== pinConfirm) return 'The two PIN entries do not match.';
    return '';
  }

  // Keep only digits in the PIN fields.
  pinInputs.forEach((input) => {
    input.addEventListener('input', () => {
      input.value = input.value.replace(/\D/g, '').slice(0, 4);
    });
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    showError('');

    const values = {
      databaseUrl: byId('setup-url').value.trim(),
      databaseKey: byId('setup-key').value.trim(),
      pin: byId('setup-pin').value,
      pinConfirm: byId('setup-pin-confirm').value,
    };

    const problem = validate(values);
    if (problem) {
      showError(problem);
      return;
    }

    setBusy(true);
    const connection = await testConnection(values);
    if (!connection.ok) {
      setBusy(false);
      showError(connection.message);
      return;
    }

    try {
      await saveCredentials({ databaseUrl: values.databaseUrl, databaseKey: values.databaseKey, pin: values.pin });
    } catch (error) {
      setBusy(false);
      showError(error.message);
      return;
    }

    startSession({ remember: false });
    form.reset();
    setBusy(false);
    overlay.close();
    onComplete();
  });

  // shared: { databaseUrl, databaseKey } from the Worker, or null to ask for them.
  function show(shared = null) {
    databaseFields.forEach((field) => {
      field.hidden = Boolean(shared);
    });
    byId('setup-title').textContent = shared ? 'Create your PIN' : 'Connect your portfolio';
    byId('setup-text').textContent = shared
      ? 'The PIN locks the dashboard on this device. You sign in with your email and password next.'
      : 'These details stay in this browser. They are never saved in the code or on GitHub.';
    if (shared) {
      byId('setup-url').value = shared.databaseUrl;
      byId('setup-key').value = shared.databaseKey;
    }
    overlay.open({ focusSelector: shared ? '#setup-pin' : '#setup-url' });
  }

  return { show };
}
