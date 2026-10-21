// Short messages at the bottom of the screen.

import { byId } from './dom.js';

const DISPLAY_MS = 3600;
let hideTimer = null;

export function showToast(message, tone = 'neutral') {
  const toast = byId('toast');
  toast.textContent = message;
  toast.dataset.tone = tone;
  toast.hidden = false;

  // Restart the entrance animation when a new message replaces an old one.
  toast.classList.remove('is-visible');
  void toast.offsetWidth;
  toast.classList.add('is-visible');

  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    toast.classList.remove('is-visible');
    toast.hidden = true;
  }, DISPLAY_MS);
}
