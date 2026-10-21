// PIN lock screen with animated dots, an on-screen keypad and keyboard support.

import { PIN_LOCKOUT_SECONDS, PIN_MAX_ATTEMPTS } from '../config.js';
import { clearAllSavedData, startSession, verifyPin } from '../services/auth.js';
import { byId, setText } from './dom.js';
import { createOverlay } from './overlay.js';

const PIN_LENGTH = 4;
const SUCCESS_DELAY_MS = 240;
const ERROR_ANIMATION_MS = 420;

export function initLockScreen({ onUnlock }) {
  const overlay = createOverlay('lock-screen', { dismissible: false });
  const dotsBox = byId('pin-dots');
  const dots = [...dotsBox.querySelectorAll('.pin-dot')];
  const keys = [...byId('lock-keypad').querySelectorAll('button')];
  const rememberBox = byId('lock-remember');

  let entered = '';
  let failures = 0;
  let isBusy = false;
  let lockedUntil = 0;
  let countdownTimer = null;

  function renderDots() {
    dots.forEach((dot, index) => dot.classList.toggle('is-filled', index < entered.length));
  }

  function setKeysDisabled(disabled) {
    keys.forEach((key) => {
      key.disabled = disabled;
    });
  }

  function startLockout() {
    lockedUntil = Date.now() + PIN_LOCKOUT_SECONDS * 1000;
    failures = 0;
    setKeysDisabled(true);

    clearInterval(countdownTimer);
    countdownTimer = setInterval(() => {
      const secondsLeft = Math.ceil((lockedUntil - Date.now()) / 1000);
      if (secondsLeft <= 0) {
        clearInterval(countdownTimer);
        setKeysDisabled(false);
        setText('lock-message', 'Enter your PIN.');
        return;
      }
      setText('lock-message', `Too many wrong attempts. Try again in ${secondsLeft} seconds.`);
    }, 250);
  }

  function clearEntry() {
    entered = '';
    renderDots();
  }

  async function submit() {
    isBusy = true;
    let isCorrect = false;

    try {
      isCorrect = await verifyPin(entered);
    } catch (error) {
      setText('lock-message', error.message);
    }

    if (isCorrect) {
      dotsBox.classList.add('is-success');
      startSession({ remember: rememberBox.checked });
      setTimeout(() => {
        document.removeEventListener('keydown', handleKeydown);
        overlay.close();
        onUnlock();
      }, SUCCESS_DELAY_MS);
      return;
    }

    failures += 1;
    dotsBox.classList.add('is-error');
    if (failures >= PIN_MAX_ATTEMPTS) {
      startLockout();
    } else {
      setText('lock-message', 'Wrong PIN. Try again.');
    }

    setTimeout(() => {
      dotsBox.classList.remove('is-error');
      clearEntry();
      isBusy = false;
    }, ERROR_ANIMATION_MS);
  }

  function addDigit(digit) {
    if (isBusy || Date.now() < lockedUntil || entered.length >= PIN_LENGTH) return;
    entered += digit;
    renderDots();
    if (entered.length === PIN_LENGTH) submit();
  }

  function removeDigit() {
    if (isBusy || entered.length === 0) return;
    entered = entered.slice(0, -1);
    renderDots();
  }

  function handleKeydown(event) {
    if (/^\d$/.test(event.key)) addDigit(event.key);
    else if (event.key === 'Backspace') removeDigit();
  }

  byId('lock-keypad').addEventListener('click', (event) => {
    const key = event.target.closest('button');
    if (!key) return;
    if (key.dataset.key === 'delete') removeDigit();
    else addDigit(key.dataset.key);
  });

  byId('lock-reset').addEventListener('click', () => {
    const message = 'Reset credentials? The Supabase details and the PIN saved on this device will be deleted.';
    if (window.confirm(message)) {
      clearAllSavedData();
      window.location.reload();
    }
  });

  function show() {
    entered = '';
    isBusy = false;
    rememberBox.checked = false;
    dotsBox.classList.remove('is-success', 'is-error');
    renderDots();
    setKeysDisabled(Date.now() < lockedUntil);
    setText('lock-message', 'Enter your PIN.');
    document.addEventListener('keydown', handleKeydown);
    overlay.open({ focusSelector: '[data-key="1"]' });
  }

  return { show };
}
