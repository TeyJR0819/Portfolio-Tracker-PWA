// Overlays: the setup wizard, the lock screen and the transaction drawer.
// Each one is a full-screen layer in index.html that fades or slides in.

import { byId } from './dom.js';

// Must match --duration-overlay in css/base.css.
const CLOSE_DELAY_MS = 280;
const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

let openCount = 0;

export function createOverlay(id, { dismissible = true, onClose = null } = {}) {
  const root = byId(id);
  let returnFocusTo = null;
  let closeTimer = null;
  let isCounted = false; // true while this overlay is included in openCount

  function getFocusable() {
    return [...root.querySelectorAll(FOCUSABLE)].filter((element) => !element.closest('[hidden]'));
  }

  function handleKeydown(event) {
    if (event.key === 'Escape' && dismissible) {
      close();
      return;
    }
    if (event.key !== 'Tab') return;

    const items = getFocusable();
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function open({ focusSelector = null } = {}) {
    clearTimeout(closeTimer);
    closeTimer = null;
    if (!isCounted) {
      isCounted = true;
      openCount += 1;
      returnFocusTo = document.activeElement;
    }
    root.hidden = false;
    document.body.classList.add('is-scroll-locked');
    root.addEventListener('keydown', handleKeydown);

    requestAnimationFrame(() => {
      root.classList.add('is-open');
      const target = (focusSelector && root.querySelector(focusSelector)) || getFocusable()[0];
      target?.focus();
    });
  }

  function close() {
    if (root.hidden || closeTimer !== null) return;
    root.classList.remove('is-open');
    root.removeEventListener('keydown', handleKeydown);

    closeTimer = setTimeout(() => {
      closeTimer = null;
      isCounted = false;
      root.hidden = true;
      openCount = Math.max(0, openCount - 1);
      if (openCount === 0) document.body.classList.remove('is-scroll-locked');
      returnFocusTo?.focus?.();
      onClose?.();
    }, CLOSE_DELAY_MS);
  }

  if (dismissible) {
    root.addEventListener('click', (event) => {
      if (event.target === root) close();
    });
    root.querySelectorAll('[data-overlay-close]').forEach((button) => button.addEventListener('click', close));
  }

  return { open, close, root };
}
