// The sign-in screen. The database answers only the signed-in owner, so this comes before the dashboard.

import { clearAllSavedData } from '../services/auth.js';
import { signIn } from '../services/database.js';
import { byId } from './dom.js';
import { createOverlay } from './overlay.js';

export function initSigninScreen({ onSignedIn }) {
  const overlay = createOverlay('signin-screen', { dismissible: false });
  const form = byId('signin-form');
  const emailInput = byId('signin-email');
  const passwordInput = byId('signin-password');
  const submitButton = byId('signin-submit');
  const errorBox = byId('signin-error');
  const messageBox = byId('signin-message');

  function showError(message) {
    errorBox.textContent = message;
    errorBox.hidden = !message;
  }

  function setBusy(isBusy) {
    submitButton.disabled = isBusy;
    submitButton.textContent = isBusy ? 'Signing in' : 'Sign in';
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    showError('');

    const email = emailInput.value.trim();
    const password = passwordInput.value;
    if (!email || !password) {
      showError('Enter your email and password.');
      return;
    }

    setBusy(true);
    try {
      await signIn(email, password);
      form.reset();
      overlay.close();
      onSignedIn();
    } catch (error) {
      passwordInput.value = '';
      showError(error.message);
    } finally {
      setBusy(false);
    }
  });

  byId('signin-reset').addEventListener('click', () => {
    if (window.confirm('Reset credentials? The Supabase details and the PIN saved on this device will be deleted.')) {
      clearAllSavedData();
      window.location.reload();
    }
  });

  // message: an optional sentence above the form, for example "Your sign-in has expired."
  function show(message = '') {
    messageBox.textContent = message;
    messageBox.hidden = !message;
    showError('');
    overlay.open({ focusSelector: '#signin-email' });
  }

  return { show };
}
